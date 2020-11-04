const Web3 = require("web3");
const TruffleContract = require("@truffle/contract");
const SuperfluidABI = require("../build/abi");
const getConfig = require("./getConfig");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";


/**
 * @dev Superfluid Framework class
 */
module.exports = class Framework {

    /**
     * @dev Create new Superfluid framework object
     * @param {Web3.Provider} web3Provider web3 provider object
     * @param {boolean} isTruffle if the framework is used within truffle environment
     * @param {string} version protocol contract version
     * @param {string} chainId force chainId, instead relying on web3.eth.net.getId
     * @param {string} resolverAddress force resolver address
     * @param {string[]} tokens the tokens to be loaded, each element is an alias for the underlying token
     * @return {Framework} The Framework object
     *
     * NOTE: You should call async function Framework.initialize to initialize the object.
     */
    constructor({
        web3Provider,
        isTruffle,
        version,
        chainId,
        resolverAddress,
        tokens
    }) {
        const contractNames = Object.keys(SuperfluidABI);

        this.chainId = chainId;
        this.version = version || "test";
        this.resolverAddress = resolverAddress;

        // load contracts
        this.contracts = {};
        if (!isTruffle) {
            console.debug("Using Superfluid SDK outside of the truffle environment");
            if (!web3Provider) throw new Error("web3Provider is required");
            // load contracts from ABI
            contractNames.forEach(i => {
                const c = this.contracts[i] = TruffleContract({
                    contractName: i,
                    abi: SuperfluidABI[i]
                });
                c.setProvider(web3Provider);
            });
            this.web3 = new Web3(web3Provider);
        } else {
            console.debug("Using Superfluid SDK within the truffle environment");
            // load contracts from truffle artifacts
            contractNames.forEach(i => {
                this.contracts[i] = global.artifacts.require(i);
            });
            // assuming web3 is available when truffle artifacts available
            this.web3 = global.web3;
        }

        this._tokens = tokens;
    }


    /**
     * @dev Initialize the framework object
     * @return {Promise}
     */
    async initialize() {
        const chainId = this.chainId || await this.web3.eth.net.getId(); // TODO use eth.getChainId;
        console.log("chainId", chainId);

        const config = getConfig(chainId);

        const resolverAddress = this.resolverAddress || config.resolverAddress;
        console.debug("Resolver at", resolverAddress);
        this.resolver = await this.contracts.IResolver.at(resolverAddress);

        // load superfluid host contract
        console.debug("Resolving contracts with version", this.version);
        const superfluidAddress = await this.resolver.get.call(`Superfluid.${this.version}`);
        this.host = await this.contracts.ISuperfluid.at(superfluidAddress);
        console.debug(`Superfluid host contract: TruffleContract .host @${superfluidAddress}`);

        // load agreements
        const cfav1Type = this.web3.utils.sha3("org.superfluid-finance.agreements.ConstantFlowAgreement.v1");
        const idav1Type = this.web3.utils.sha3("org.superfluid-finance.agreements.InstantDistributionAgreement.v1");
        const cfaAddress = await this.host.getAgreementClass.call(cfav1Type);
        const idaAddress = await this.host.getAgreementClass.call(idav1Type);
        this.agreements = {
            cfa : await this.contracts.IConstantFlowAgreementV1.at(cfaAddress),
            ida : await this.contracts.IInstantDistributionAgreementV1.at(idaAddress),
        };

        // load agreement helpers
        this.cfa = new (require("./ConstantFlowAgreementV1Helper"))(this);
        this.ida = new (require("./InstantDistributionAgreementV1Helper"))(this);
        console.debug(`ConstantFlowAgreementV1: TruffleContract .agreements.cfa @${cfaAddress} | Helper .cfa`);
        console.debug(`InstantDistributionAgreementV1: TruffleContract .agreements.ida @${idaAddress} | Helper .ida`);

        // load tokens
        this.tokens = {};
        if (this._tokens) {
            for (let i = 0; i < this._tokens.length; ++i) {
                const tokenSymbol = this._tokens[i];
                const underlyingToken = await this.resolver.get(`tokens.${tokenSymbol}`);
                if (underlyingToken === ZERO_ADDRESS) {
                    throw new Error(`Token ${tokenSymbol} is not registered`);
                }
                const wrapper = await this.getERC20Wrapper(underlyingToken);
                if (!wrapper.created) {
                    throw new Error(`Token ${tokenSymbol} doesn't have a super token wrapper`);
                }
                const superToken = await this.contracts.ISuperToken.at(wrapper.wrapperAddress);
                const superTokenSymbol = await superToken.symbol();
                this.tokens[tokenSymbol] = await this.contracts.ERC20WithTokenInfo.at(underlyingToken);
                this.tokens[superTokenSymbol] = superToken;
                console.debug(`${tokenSymbol}: ERC20WithTokenInfo .tokens["${tokenSymbol}"] @${underlyingToken}`);
                console.debug(`${superTokenSymbol}: ISuperToken .tokens["${superTokenSymbol}"] @${underlyingToken}`);
            }
        }

        this.utils = new (require("./Utils"))(this);
    }

    /**
     * @dev Get ERC20 wrapper from underlying token
     * @param {Any} tokenInfo Either a TokenInfo contract object, or address to the underlying token
     * @return {Promise<object>} It returns the wrapper result with fields:
     *         - result.created, is the wrapper created
     *         - and result.wrapperAddress, if created the address
     */
    async getERC20Wrapper(tokenInfo) {
        if (typeof(tokenInfo) == "string") {
            tokenInfo = await this.contracts.TokenInfo.at(tokenInfo);
        }
        const tokenInfoSymbol = await tokenInfo.symbol.call();
        return await this.host.getERC20Wrapper.call(
            tokenInfo.address,
            `${tokenInfoSymbol}x`,
        );
    }

    /**
     * @dev Create the ERC20 wrapper from underlying token
     * @param {Any} tokenInfo the TokenInfo contract object to the underlying token
     * @param {address} from (optional) send transaction from
     * @return {Promise<Transaction>} web3 transaction object
     */
    async createERC20Wrapper(tokenInfo, from) {
        const tokenInfoName = await tokenInfo.name.call();
        const tokenInfoSymbol = await tokenInfo.symbol.call();
        const tokenInfoDecimals = await tokenInfo.decimals.call();
        return await this.host.createERC20Wrapper(
            tokenInfo.address,
            tokenInfoDecimals,
            `Super ${tokenInfoName}`,
            `${tokenInfoSymbol}x`,
            ...(from && [{ from }] || []) // don't mind this silly js stuff, thanks to web3.js
        );
    }

};
