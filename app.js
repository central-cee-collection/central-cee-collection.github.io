/* Central Cee Collection claim page. Read-only calls use BNB Chain RPC;
   wallet transactions are sent only after an explicit click and wallet approval. */
(() => {
  'use strict';

  const ethers = window.ethers;
  const CHAIN_ID = 56n;
  const RPC_URL = 'https://bsc-dataseed.bnbchain.org/';
  const CONTRACT_ADDRESS = '0x9046f917E089e030Dc9C63D53202Ff85654f386e';
  const IMPLEMENTATION_ADDRESS = '0xeb0efef57f956e4d94ab1241f46e420e9137520a';
  const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
  const READ_CONCURRENCY = 5;
  const CLAIM_BATCH_SIZE = 20;
  const MAX_TOKEN_ID = 10000;
  const MAX_PERIODS = 100;
  const MAX_ESTIMATED_GAS = 5000000n;
  const ABI = [
    'function name() view returns (string)',
    'function supplyCap() view returns (uint256)',
    'function burnCount() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function ownerOf(uint256) view returns (address)',
    'function claimWhiteListRequired() view returns (bool)',
    'function whitelist(address) view returns (bool)',
    'function tokenPeriods(address,uint256) view returns (uint256 start,uint256 startCap,uint256 startMaxTokenId,uint128 shareEarnings,uint128 earningsAccountedFor)',
    'function getLeftToClaim(address,uint256,uint256[]) view returns (uint256[])',
    'function claimEarnings(address,uint256,address,uint256[])',
    'function claimEarningsNative(uint256,address,uint256[])'
  ];
  const TOKEN_ABI = [
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)'
  ];

  const ui = Object.fromEntries([
    'wallet', 'token', 'customToken', 'customTokenField', 'connectButton', 'checkButton',
    'claimButton', 'stopButton', 'status', 'results', 'availableAmount', 'heldCount',
    'transactionCount', 'contractStatus', 'nftIds', 'periods', 'claimNotice',
    'transactionsSection', 'transactions'
  ].map(id => [id, document.getElementById(id)]));

  if (!ethers) {
    ui.status.textContent = 'The local wallet library could not be loaded. Please reload the page.';
    ui.status.className = 'status error';
    ui.checkButton.disabled = true;
    return;
  }

  const readProvider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), {
    staticNetwork: ethers.Network.from(Number(CHAIN_ID)),
    batchMaxCount: 1
  });
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider);
  const tokenInterface = new ethers.Interface(TOKEN_ABI);
  let checked = null;
  let busy = false;
  let stopRequested = false;

  function setStatus(message, kind = '') {
    ui.status.textContent = message;
    ui.status.className = `status ${kind}`.trim();
  }

  function setBusy(value) {
    busy = value;
    ui.wallet.disabled = value;
    ui.token.disabled = value;
    ui.customToken.disabled = value;
    ui.connectButton.disabled = value;
    ui.checkButton.disabled = value;
    ui.claimButton.disabled = value || !checked?.canClaim;
  }

  function invalidate() {
    if (busy) return;
    checked = null;
    ui.results.hidden = true;
    ui.claimButton.disabled = true;
    setStatus('Ready to check.');
  }

  function errorText(error) {
    const text = error?.shortMessage || error?.reason || error?.message || 'Unknown error';
    if (error?.code === 'ACTION_REJECTED' || /user rejected|user denied/i.test(text)) {
      return 'The wallet request was declined. No transaction was sent.';
    }
    return String(text).slice(0, 300);
  }

  function isMissingToken(error) {
    return error?.code === 'CALL_EXCEPTION' &&
      /ERC721: invalid token ID/i.test(`${error.reason || ''} ${error.shortMessage || ''} ${error.message || ''}`);
  }

  function isMissingPeriod(error) {
    // This verified contract's public tokenPeriods getter reverts with empty data
    // when the array index is beyond its last element.
    return error?.code === 'CALL_EXCEPTION' && error?.data === '0x';
  }

  async function readWithRetry(read) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (error?.code === 'CALL_EXCEPTION') throw error;
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function verifyContract() {
    const [network, storage] = await Promise.all([
      readProvider.getNetwork(),
      readWithRetry(() => readProvider.getStorage(CONTRACT_ADDRESS, IMPLEMENTATION_SLOT))
    ]);
    if (network.chainId !== CHAIN_ID) throw new Error('The read connection is not on BNB Smart Chain.');
    const implementation = ethers.getAddress(`0x${storage.slice(-40)}`);
    if (implementation.toLowerCase() !== IMPLEMENTATION_ADDRESS) {
      throw new Error('The claim contract was upgraded. This page needs review before it can be used.');
    }
    const name = await readWithRetry(() => contract.name());
    if (name !== 'Central Cee Collection') {
      throw new Error('The connected contract is not the expected NFT collection.');
    }
  }

  function selectedToken() {
    const value = ui.token.value === 'custom' ? ui.customToken.value.trim() : ui.token.value;
    if (!ethers.isAddress(value)) throw new Error('Enter a valid token contract address.');
    return ethers.getAddress(value);
  }

  async function tokenInfo(tokenAddress) {
    if (tokenAddress.toLowerCase() === NATIVE_TOKEN) return {symbol: 'BNB', decimals: 18, contract: null};
    const token = new ethers.Contract(tokenAddress, TOKEN_ABI, readProvider);
    const [rawDecimals, rawSymbol] = await Promise.all([
      readWithRetry(() => token.decimals()),
      readWithRetry(() => token.symbol())
    ]);
    const decimals = Number(rawDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error('The selected token reported an unsupported decimal count.');
    }
    const symbol = String(rawSymbol).replace(/[^\w.-]/g, '').slice(0, 16) || 'TOKEN';
    return {symbol, decimals, contract: token};
  }

  async function scanOwnedTokens(owner, expectedBalance, highestId) {
    if (expectedBalance === 0) return [];
    let nextId = 1;
    let completed = 0;
    let aborted = false;
    const found = [];
    const workers = Array.from({length: Math.min(READ_CONCURRENCY, highestId)}, async () => {
      while (!aborted) {
        const id = nextId++;
        if (id > highestId) break;
        try {
          const actual = await readWithRetry(() => contract.ownerOf(id));
          if (actual.toLowerCase() === owner.toLowerCase()) found.push(BigInt(id));
        } catch (error) {
          if (!isMissingToken(error)) {
            aborted = true;
            throw new Error(`Could not verify NFT #${id}: ${errorText(error)}`);
          }
        } finally {
          completed++;
          if (completed % 20 === 0 || completed === highestId) {
            setStatus(`Checking NFT ownership… ${completed}/${highestId}`);
          }
        }
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    found.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (found.length !== expectedBalance) {
      throw new Error(`NFT scan found ${found.length}, but the contract reports ${expectedBalance}. No claim will be prepared until this is resolved.`);
    }
    return found;
  }

  function chunks(items, size) {
    const result = [];
    for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
    return result;
  }

  async function findClaimPeriods(tokenAddress, shareIds) {
    const periods = [];
    const jobs = [];
    for (let index = 0; index < MAX_PERIODS; index++) {
      let raw;
      try {
        raw = await readWithRetry(() => contract.tokenPeriods(tokenAddress, index));
      } catch (error) {
        if (isMissingPeriod(error)) return {periods, jobs};
        throw new Error(`Could not read distribution period ${index}: ${errorText(error)}`);
      }

      const period = {
        index,
        start: raw.start,
        maxTokenId: raw.startMaxTokenId,
        amountRemaining: raw.earningsAccountedFor,
        amount: 0n,
        claimableCount: 0,
        unavailable: raw.earningsAccountedFor === 0n
      };

      if (!period.unavailable && raw.shareEarnings > 0n) {
        const eligible = shareIds.filter(id => id <= period.maxTokenId);
        for (const group of chunks(eligible, CLAIM_BATCH_SIZE)) {
          const amounts = await readWithRetry(() => contract.getLeftToClaim(tokenAddress, index, group));
          if (amounts.length !== group.length) throw new Error(`Unexpected earnings response for period ${index}.`);
          const idsToClaim = [];
          let groupAmount = 0n;
          amounts.forEach((amount, position) => {
            if (amount > 0n) {
              idsToClaim.push(group[position]);
              groupAmount += amount;
            }
          });
          if (groupAmount > 0n) {
            jobs.push({periodIndex: index, ids: idsToClaim, amount: groupAmount});
            period.amount += groupAmount;
            period.claimableCount += idsToClaim.length;
          }
        }
      }
      if (period.amount > period.amountRemaining) {
        throw new Error(`Period ${index} reports less remaining in the contract than this wallet's calculated earnings. No claim will be prepared.`);
      }
      periods.push(period);
      setStatus(`Checking distribution periods… ${index + 1} found`);
    }
    throw new Error('More distribution periods exist than this page can safely inspect.');
  }

  async function contractFunds(tokenAddress, info) {
    return info.contract
      ? readWithRetry(() => info.contract.balanceOf(CONTRACT_ADDRESS))
      : readWithRetry(() => readProvider.getBalance(CONTRACT_ADDRESS));
  }

  function amountText(value, info) {
    return `${ethers.formatUnits(value, info.decimals)} ${info.symbol}`;
  }

  function render(lookup) {
    const total = lookup.jobs.reduce((sum, job) => sum + job.amount, 0n);
    ui.availableAmount.textContent = amountText(total, lookup.info);
    ui.heldCount.textContent = `${lookup.shareIds.length} / ${lookup.highestId}`;
    ui.transactionCount.textContent = String(lookup.jobs.length);
    ui.contractStatus.textContent = `Contract claim whitelist: ${lookup.whitelistRequired ? 'ON' : 'OFF'}${lookup.whitelistRequired ? (lookup.ownerWhitelisted ? ' · This wallet is whitelisted' : ' · This wallet is not whitelisted') : ''}.`;
    ui.nftIds.textContent = lookup.shareIds.length ? lookup.shareIds.map(id => id.toString()).join(', ') : 'None';
    ui.periods.replaceChildren();

    if (lookup.periods.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'period-row';
      empty.textContent = `No ${lookup.info.symbol} distribution periods were found.`;
      ui.periods.append(empty);
    }
    for (const period of lookup.periods) {
      const row = document.createElement('div');
      row.className = 'period-row';
      const label = document.createElement('span');
      const date = new Date(Number(period.start) * 1000).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
      label.textContent = `Distribution ${period.index + 1}`;
      const small = document.createElement('small');
      small.textContent = `Started ${date}${period.unavailable ? ' · no funds remain in this period' : ''}`;
      label.append(small);
      const amount = document.createElement('strong');
      amount.textContent = amountText(period.amount, lookup.info);
      row.append(label, amount);
      ui.periods.append(row);
    }

    const blockers = [];
    if (lookup.shareIds.length === 0) blockers.push('This wallet currently holds no NFTs from this collection.');
    else if (total === 0n) blockers.push('No earnings are currently available for these NFTs and this currency.');
    if (total > 0n && lookup.whitelistRequired && !lookup.ownerWhitelisted) {
      blockers.push('The contract still requires a whitelisted wallet for claims. Please wait for the contract-level change.');
    }
    if (total > lookup.funds) {
      blockers.push(`The contract holds ${amountText(lookup.funds, lookup.info)}, less than this wallet's calculated ${amountText(total, lookup.info)}. Withdrawals are paused here until funds are checked.`);
    }
    ui.claimNotice.textContent = blockers.length
      ? blockers.join(' ')
      : `Each of the ${lookup.jobs.length} transaction${lookup.jobs.length === 1 ? '' : 's'} will require separate wallet approval. Results can change before you withdraw.`;
    ui.claimNotice.className = blockers.length ? 'notice error' : 'notice';
    lookup.canClaim = blockers.length === 0;
    ui.claimButton.disabled = !lookup.canClaim;
    ui.results.hidden = false;
  }

  async function checkEarnings() {
    if (busy) return;
    checked = null;
    ui.results.hidden = true;
    ui.claimButton.disabled = true;
    setBusy(true);
    try {
      const owner = ethers.getAddress(ui.wallet.value.trim());
      const tokenAddress = selectedToken();
      setStatus('Verifying the BNB Chain contract…');
      await verifyContract();
      const [supplyCap, burnCount, balance, whitelistRequired, info] = await Promise.all([
        readWithRetry(() => contract.supplyCap()),
        readWithRetry(() => contract.burnCount()),
        readWithRetry(() => contract.balanceOf(owner)),
        readWithRetry(() => contract.claimWhiteListRequired()),
        tokenInfo(tokenAddress)
      ]);
      const highestId = Number(supplyCap + burnCount);
      const expectedBalance = Number(balance);
      if (!Number.isSafeInteger(highestId) || highestId < 1 || highestId > MAX_TOKEN_ID ||
          !Number.isSafeInteger(expectedBalance) || expectedBalance < 0 || expectedBalance > highestId) {
        throw new Error('The contract returned an NFT count outside this page’s safety limit.');
      }
      const ownerWhitelisted = whitelistRequired
        ? await readWithRetry(() => contract.whitelist(owner))
        : true;
      const shareIds = await scanOwnedTokens(owner, expectedBalance, highestId);
      const {periods, jobs} = await findClaimPeriods(tokenAddress, shareIds);
      const funds = await contractFunds(tokenAddress, info);
      checked = {owner, tokenAddress, info, highestId, shareIds, periods, jobs,
        whitelistRequired, ownerWhitelisted, funds, canClaim: false};
      render(checked);
      setStatus(`Found ${shareIds.length} NFTs in a collection with ${highestId} IDs; checked ${periods.length} ${info.symbol} distribution periods.`, 'success');
    } catch (error) {
      console.error('Earnings check failed:', error);
      setStatus(`Check failed: ${errorText(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error('No browser wallet was found. Open this page in a wallet-enabled browser.');
    const accounts = await window.ethereum.request({method: 'eth_requestAccounts'});
    if (!accounts?.length) throw new Error('The wallet did not return an account.');
    return ethers.getAddress(accounts[0]);
  }

  async function walletSigner(expectedOwner) {
    const account = await connectWallet();
    if (account.toLowerCase() !== expectedOwner.toLowerCase()) {
      throw new Error(`Connect the NFT owner wallet (${expectedOwner}) to withdraw. The connected wallet is ${account}.`);
    }
    let chainId = BigInt(await window.ethereum.request({method: 'eth_chainId'}));
    if (chainId !== CHAIN_ID) {
      await window.ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x38'}]});
      chainId = BigInt(await window.ethereum.request({method: 'eth_chainId'}));
    }
    if (chainId !== CHAIN_ID) throw new Error('Switch your wallet to BNB Smart Chain before withdrawing.');
    const walletProvider = new ethers.BrowserProvider(window.ethereum);
    return walletProvider.getSigner();
  }

  async function verifyTokenTransfer(tokenAddress, owner, amount) {
    const data = tokenInterface.encodeFunctionData('transfer', [owner, amount]);
    let returned;
    try {
      // Read-only simulation from the NFT contract's address. The NFT contract
      // does not check the ERC-20 transfer return value, so we must check it here.
      returned = await readProvider.call({from: CONTRACT_ADDRESS, to: tokenAddress, data});
    } catch (error) {
      throw new Error(`The token transfer simulation failed: ${errorText(error)}`);
    }
    if (returned === '0x') throw new Error('The token did not return a success value for a simulated transfer. This page will not risk marking earnings claimed without a payout.');
    const success = tokenInterface.decodeFunctionResult('transfer', returned)[0];
    if (!success) throw new Error('The token reported a failed transfer. No claim was sent.');
  }

  function appendTransaction(hash, periodIndex, ids) {
    ui.transactionsSection.hidden = false;
    const item = document.createElement('li');
    item.textContent = `Distribution ${periodIndex + 1}, ${ids.length} NFT${ids.length === 1 ? '' : 's'}: `;
    const link = document.createElement('a');
    link.href = `https://bscscan.com/tx/${hash}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${hash.slice(0, 12)}…${hash.slice(-8)}`;
    item.append(link);
    ui.transactions.append(item);
  }

  function verifyTransferReceipt(receipt, tokenAddress, owner, expectedAmount) {
    let paid = 0n;
    const transferTopic = ethers.id('Transfer(address,address,uint256)').toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== tokenAddress.toLowerCase() ||
          log.topics[0]?.toLowerCase() !== transferTopic) continue;
      const decoded = tokenInterface.parseLog(log);
      if (decoded.args.from.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
          decoded.args.to.toLowerCase() === owner.toLowerCase()) paid += decoded.args.value;
    }
    if (paid < expectedAmount) {
      throw new Error(`Transaction ${receipt.hash} confirmed, but its token transfer could not be verified for the expected amount. Do not retry this batch until it has been reviewed on BscScan.`);
    }
  }

  async function claimEarnings() {
    if (busy || !checked?.canClaim) return;
    const plan = checked;
    setBusy(true);
    stopRequested = false;
    ui.stopButton.hidden = false;
    ui.stopButton.disabled = false;
    let confirmed = 0;
    try {
      setStatus('Connect the NFT owner wallet to continue…');
      const signer = await walletSigner(plan.owner);
      await verifyContract();
      const whitelistRequired = await contract.claimWhiteListRequired();
      if (whitelistRequired && !(await contract.whitelist(plan.owner))) {
        throw new Error('The contract still requires this wallet to be whitelisted. No claim was sent.');
      }
      const writer = contract.connect(signer);

      for (const job of plan.jobs) {
        if (stopRequested) break;
        const [activeAccounts, activeChain] = await Promise.all([
          window.ethereum.request({method: 'eth_accounts'}),
          window.ethereum.request({method: 'eth_chainId'})
        ]);
        if (!activeAccounts?.[0] || activeAccounts[0].toLowerCase() !== plan.owner.toLowerCase() ||
            BigInt(activeChain) !== CHAIN_ID) {
          throw new Error('The wallet account or network changed. Check earnings again before continuing.');
        }
        const period = await contract.tokenPeriods(plan.tokenAddress, job.periodIndex);
        if (period.earningsAccountedFor === 0n) continue;
        const amounts = await contract.getLeftToClaim(plan.tokenAddress, job.periodIndex, job.ids);
        const ids = [];
        let amount = 0n;
        amounts.forEach((value, i) => {
          if (job.ids[i] <= period.startMaxTokenId && value > 0n) {
            ids.push(job.ids[i]);
            amount += value;
          }
        });
        if (amount === 0n) continue;
        if (amount > period.earningsAccountedFor) throw new Error(`Distribution ${job.periodIndex + 1} no longer has enough allocated funds.`);
        const funds = await contractFunds(plan.tokenAddress, plan.info);
        if (funds < amount) throw new Error(`The contract balance is too low for distribution ${job.periodIndex + 1}.`);
        if (plan.info.contract) await verifyTokenTransfer(plan.tokenAddress, plan.owner, amount);

        const method = plan.info.contract ? writer.claimEarnings : writer.claimEarningsNative;
        const args = plan.info.contract
          ? [plan.tokenAddress, job.periodIndex, plan.owner, ids]
          : [job.periodIndex, plan.owner, ids];
        setStatus(`Preparing transaction ${confirmed + 1} of up to ${plan.jobs.length}: ${amountText(amount, plan.info)} from distribution ${job.periodIndex + 1}…`);
        await method.staticCall(...args);
        const gas = await method.estimateGas(...args);
        if (gas > MAX_ESTIMATED_GAS) {
          throw new Error(`This batch estimates ${gas} gas, above the page safety limit. No transaction was sent.`);
        }
        const tx = await method(...args);
        appendTransaction(tx.hash, job.periodIndex, ids);
        setStatus(`Transaction submitted. Waiting for confirmation: ${tx.hash}`);
        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${tx.hash} did not confirm successfully. Check it on BscScan before trying again.`);
        confirmed++;
        if (plan.info.contract) verifyTransferReceipt(receipt, plan.tokenAddress, plan.owner, amount);
        setStatus(`${confirmed} transaction${confirmed === 1 ? '' : 's'} confirmed. ${plan.jobs.length - confirmed} planned batch${plan.jobs.length - confirmed === 1 ? '' : 'es'} remain.`, 'success');
      }
      checked = null;
      ui.claimButton.disabled = true;
      ui.claimNotice.textContent = stopRequested
        ? `${confirmed} transaction${confirmed === 1 ? '' : 's'} confirmed. The remaining batches were stopped. Check earnings again to refresh the plan.`
        : `${confirmed} transaction${confirmed === 1 ? '' : 's'} confirmed. Check earnings again to verify the final balance.`;
      setStatus(ui.claimNotice.textContent, 'success');
    } catch (error) {
      console.error('Claim stopped:', error);
      checked = null;
      ui.claimButton.disabled = true;
      ui.claimNotice.textContent = 'The claim plan is now out of date. Check earnings again before continuing.';
      setStatus(`Claim stopped after ${confirmed} confirmed transaction${confirmed === 1 ? '' : 's'}: ${errorText(error)}`, 'error');
    } finally {
      ui.stopButton.hidden = true;
      setBusy(false);
    }
  }

  ui.token.addEventListener('change', () => {
    ui.customTokenField.hidden = ui.token.value !== 'custom';
    invalidate();
  });
  ui.wallet.addEventListener('input', invalidate);
  ui.customToken.addEventListener('input', invalidate);
  ui.checkButton.addEventListener('click', checkEarnings);
  ui.claimButton.addEventListener('click', claimEarnings);
  ui.stopButton.addEventListener('click', () => {
    stopRequested = true;
    ui.stopButton.disabled = true;
    setStatus('Stopping after the current wallet transaction finishes…');
  });
  ui.connectButton.addEventListener('click', async () => {
    if (busy) return;
    try {
      const owner = await connectWallet();
      ui.wallet.value = owner;
      invalidate();
      setStatus(`Connected wallet: ${owner}`);
    } catch (error) {
      setStatus(`Could not connect wallet: ${errorText(error)}`, 'error');
    }
  });
  if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', invalidate);
    window.ethereum.on('chainChanged', invalidate);
  }
})();
