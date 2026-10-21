import { Container } from '@cloudflare/containers';

/** The pinned C5 runtime is baked into the image; it has no outbound-network need. */
export class C5Model extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '15m';
  enableInternet = false;
}
