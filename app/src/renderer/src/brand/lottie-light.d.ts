// lottie-web ships types for its main entry but not for the light build's
// subpath. The light build has the same default export.
declare module "lottie-web/build/player/lottie_light" {
  import lottie from "lottie-web";
  export default lottie;
}
