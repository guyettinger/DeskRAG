/**
 * Regenerates every brand asset from scripts/brand/geometry.ts.
 * Run with: npm run gen:brand
 */

import { main as emitStatic } from "./emit-static.js";
import { main as emitSvg } from "./emit-svg.js";
import { main as emitLottie } from "./emit-lottie.js";
import { main as emitIcons } from "./emit-icons.js";

emitStatic();
emitSvg();
emitLottie();
await emitIcons();
