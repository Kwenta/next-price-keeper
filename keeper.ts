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
};

const provider = new ethers.providers.JsonRpcProvider(
    `https://${process.env.NETWORK}.infura.io/v3/ec6264d9beef4c33963ab0f1c2d2ee70`
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

async function main() {
    const FuturesMarkets: Contract[] = await getFuturesMarketContracts();
    const ExchangeRates: Contract = await getExchangeRatesContract();

    // Set up next price listeners
    FuturesMarkets.forEach((FuturesMarket) => {
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
                };
                console.log('Order received for:', order.account, 'from', order.trackingCode);
                orders.push(order);
            }
        );
        console.log(`${FuturesMarket.address} next price event listener set up.`);
    });

    // @TODO: Switch to CL aggregator events for less RPC calls
    provider.on('block', (block) => {
        orders.forEach(async (order) => {
            const baseAsset = await order.market.baseAsset();
            const latestRound = (await ExchangeRates.getCurrentRoundId(baseAsset)).toString();
            console.log('Current round:', latestRound, 'Order round:', order.targetRoundId);
            if (latestRound >= order.targetRoundId) {
                try {
                    await order.market.callStatic.executeNextPriceOrder(order.account);
                    console.log('attempt');
                    await order.market.executeNextPriceOrder(order.account);
                } catch (e: any) {
                    console.log(
                        'ERROR:',
                        order.account,
                        e /*JSON.parse(e.error.body).error.message*/
                    );
                }
            }
        });
    });
}

main();
