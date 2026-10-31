/// <reference types="vite/client" />

// hls.js exposes the light build through a subpath export without its own type file.
declare module 'hls.js/light' {
  import Hls from 'hls.js'
  export default Hls
}
