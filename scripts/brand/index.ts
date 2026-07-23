/**
 * Regenerates every brand asset from scripts/brand/geometry.ts.
 * Run with: npm run gen:brand
 */

import { main as emitStatic } from "./emit-static.js";
import { main as emitSvg } from "./emit-svg.js";

emitStatic();
emitSvg();
