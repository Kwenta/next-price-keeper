// MVP of next-price-order keeper
import { ethers, Contract } from 'ethers';
import optimismMainnetDeployments from './node_modules/synthetix/publish/deployed/mainnet-ovm/deployment.json';
import optimismKovanDeployments from './node_modules/synthetix/publish/deployed/kovan-ovm/deployment.json';
import dotenv from 'dotenv';

dotenv.config();

type Order = {
    account: string;
    market: Contract;
    sizeDelta: string;
    targetRoundId: string;
    commitDeposit: string;
    keeperDeposit: string;
    trackingCode: string;
    failures: number;
};

const provider = new ethers.providers.JsonRpcProvider(
    `https://${process.env.NETWORK}.infura.io/v3/${process.env.API_KEY}`
);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY ?? '', provider);

async function getFuturesMarketContracts() {
    const deploymentsArtifact =
        process.env.NETWORK == 'optimism-kovan'
            ? optimismKovanDeployments
            : optimismMainnetDeployments;
    const futuresMarketABI = deploymentsArtifact.sources.FuturesMarket.abi;
    const futuresMarketManagerAddress = deploymentsArtifact.targets.FuturesMarketManager.address;
    const futuresMarketManagerABI = deploymentsArtifact.sources.FuturesMarketManager.abi;
    const FuturesMarketManager = new ethers.Contract(
        futuresMarketManagerAddress,
        futuresMarketManagerABI,
        provider
    );
    const futuresMarkets = await FuturesMarketManager.allMarkets();
    return futuresMarkets.map(
        (address: string) => new ethers.Contract(address, futuresMarketABI, signer)
    );
}

async function getExchangeRatesContract() {
    const deploymentsArtifact =
        process.env.NETWORK == 'optimism-kovan'
            ? optimismKovanDeployments
            : optimismMainnetDeployments;
    const exchangeRatesABI = deploymentsArtifact.sources.ExchangeRates.abi;
    const exchangeRatesAddress = deploymentsArtifact.targets.ExchangeRates.address;
    return new ethers.Contract(exchangeRatesAddress, exchangeRatesABI, provider);
}

// Queue of address w/ active orders
let orders: Order[] = [];
let txQueue = new Set();

// Remove order from orders in place
function deleteOrder(account: string) {
    const index = orders.findIndex((order) => order.account === account);
    if (index >= 0) {
        orders.splice(index, 1);
    }
}

async function main() {
    const FuturesMarkets: Contract[] = await getFuturesMarketContracts();
    const ExchangeRates: Contract = await getExchangeRatesContract();

    // Set up next price listeners
    FuturesMarkets.forEach((FuturesMarket) => {
        // Enqueue placed orders
        FuturesMarket.on(
            'NextPriceOrderSubmitted',
            (
                account,
                sizeDelta,
                targetRoundId,
                commitDeposit,
                keeperDeposit,
                trackingCode,
                event
            ) => {
                const order = {
                    account,
                    market: FuturesMarket,
                    sizeDelta: sizeDelta.toString(),
                    targetRoundId: targetRoundId.toString(),
                    commitDeposit: commitDeposit.toString(),
                    keeperDeposit: keeperDeposit.toString(),
                    trackingCode: ethers.utils.parseBytes32String(trackingCode),
                    failures: 0,
                };
                console.log('Order received for:', order.account, 'from', order.trackingCode);
                orders.push(order);
            }
        );

        // Delete removed orders
        FuturesMarket.on('NextPriceOrderRemoved', (account) => {
            console.log('Order removed for:', account);
            deleteOrder(account);
        });

        console.log(`${FuturesMarket.address} next price event listeners set up.`);
    });

    let blockQueue = Promise.resolve();
    // @TODO: Switch to CL aggregator events for less RPC calls
    provider.on('block', (block) => {
        // Create promise chain for block events for sequential processing
        blockQueue = blockQueue.then(async () => {
            for (const order of orders) {
                const baseAsset = await order.market.baseAsset();
                const latestRoundBN: ethers.BigNumber = await ExchangeRates.getCurrentRoundId(
                    baseAsset
                );
                const latestRound = latestRoundBN.toString();
                console.log(
                    block,
                    'Checking order for:',
                    order.account,
                    'Rounds until target round:',
                    ethers.BigNumber.from(order.targetRoundId).sub(latestRound).toString()
                );

                // Order is stale
                if (latestRoundBN.gte(ethers.BigNumber.from(order.targetRoundId).add(2))) {
                    console.log('Order stale:', order.account);
                    deleteOrder(order.account);
                    if (!txQueue.has(order.account)) {
                        txQueue.delete(order.account);
                    }
                }
                // Order is active
                else if (latestRoundBN.gte(ethers.BigNumber.from(order.targetRoundId))) {
                    try {
                        if (!txQueue.has(order.account)) {
                            console.log('ATTEMPTING order for:', order.account);
                            txQueue.add(order.account);
                            const tx = await order.market.executeNextPriceOrder(order.account);
                            await tx.wait();
                            deleteOrder(order.account);
                            txQueue.delete(order.account);
                            console.log('SUCCESS! Order executed for:', order.account);
                        }
                    } catch (e: any) {
                        order.failures++;
                        if (order.failures >= 100) {
                            console.log('REMOVING order. Max failed attempts.', order.account);
                            deleteOrder(order.account);
                        }
                        txQueue.delete(order.account);
                        console.log('ERROR:', order.account, e);
                    }
                }
            }
        });
    });
}

main();
