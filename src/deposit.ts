import { depositAddress } from "./agent.js";
import { ASSETS } from "./policy.js";

// The token and chain the payer sends from; defaults to NEAR-native USDC.
console.log(await depositAddress(process.argv[2] ?? ASSETS.USDC));
