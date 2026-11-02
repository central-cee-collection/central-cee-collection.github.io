# Central Cee Collection NFT earnings

This repository contains a static web page for checking and claiming earnings associated with Central Cee Collection NFTs on BNB Smart Chain. The page can be hosted on GitHub Pages or any static web host. It has no application server.

## Using the page

1. Enter the address of a wallet that holds NFTs from the collection.
2. Select a currency and choose **Check earnings**. This reads public blockchain data; connecting a wallet is not required to check.
3. To withdraw available earnings, connect the same wallet that currently owns the NFTs and approve each transaction in your wallet. You need BNB for network fees. If several distributions or NFTs are involved, more than one approval may be needed.

The page never asks for a seed phrase or private key. Review each transaction in your wallet before approving it.

## How it works

`app.js` reads NFT ownership and recorded distributions from the [collection contract](https://bscscan.com/address/0x9046f917E089e030Dc9C63D53202Ff85654f386e). It shows the amount currently available for the selected currency and checks the contract state again before preparing a withdrawal. A withdrawal is sent only after the connected owner wallet approves it. The contract sends claimed funds to the NFT owner.

`index.html` and `styles.css` provide the interface. `vendor/ethers.umd.min.js` is the locally bundled [ethers.js](https://github.com/ethers-io/ethers.js) library; its license is in `vendor/LICENSE.md`. `.nojekyll` allows GitHub Pages to serve the files directly.

## Run locally

From this directory, run `python3 -m http.server 8000` and open `http://localhost:8000/` in a browser. A browser wallet is needed only to withdraw.

The page is provided as is. Use it at your own risk; the notice on the page describes the limitations in more detail.
