# BitSign web demo

Live demo: https://bitsign.umi.vision

The browser records a video, accepts an upload or selects a licensed example,
then displays the complete C5 model's English text beside playback. Results are
clip-level text with no confidence score or word alignment. Visitors can copy
or delete a result. The interface preserves the model's text, including errors.

## Development and checks

Use Node.js with npm. From this directory:

```sh
npm ci
npm run check
npm test
npm run build
```

`npm run dev` serves the interface on port 5173 and proxies `/api` to the local
Worker on port 8787. `npm run dev:api` starts that Worker with local D1, R2 and
queue state. Local example media must be populated separately; cloud media
remains private. Model execution requires the pinned Linux amd64 container.
See [the inference guide](../services/web-inference/README.md) for restoration,
build inputs, verification, deadlines and local emulation limits.

Worker integration tests exercise real workerd, D1 and R2 bindings with the model
transport mocked. They cover authentication, streamed upload bounds, leases,
interrupted dispatch, restart recovery, deletion, expiration and separate public
playback/private inference objects. These tests do not establish model quality.

## Deployment

`wrangler.jsonc` targets the UMI account and dedicated BitSign resources: a
Worker, D1 database, private R2 bucket, inference and dead-letter queues, and one
4-vCPU/12-GiB Container. Authenticate Wrangler with that account before deploying.

```sh
npx wrangler d1 migrations apply bitsign-web-jobs --remote
npm run types
npm run deploy
```

The configuration pins an immutable image in Cloudflare Registry. Frontend and
Worker deployments reuse that image. A model-adapter change requires rebuilding
the Dockerfile, publishing the verified image and updating its digest in the
configuration before deployment.

Apply every migration before deploying its consuming Worker. Existing completed
results without a preprocessing receipt remain readable. The scheduled handler
runs every two minutes to recover interrupted submissions, release terminal
inputs and remove expired jobs. Lease checks prevent a deleted job from being
recreated by a delayed result. Keep model IDs pinned on existing jobs.

## Media and results

The initial limit is 30 seconds and 50 MiB. Larger frame sizes and frame rates
are optimized when they exceed the model's decoded-work budget, preserving full
framing and duration. The result retains source/inference identities, dimensions
and normalization status. MP4, WebM, MOV and M4V are supported.

User uploads are removed after terminal processing; job results expire after
24 hours. Visitors can delete both earlier. Uploads are used for this inference
request and are not added to a training dataset. Access tokens are stored only
in the current browser tab and an HTTP-only job cookie; D1 stores their hashes.

`examples/catalog.json` pins six licensed FSboard training clips with references
and attribution. Public playback uses face-blurred copies to follow the source
dataset's publicity guidance. The model receives the private originals, and the
page explains this treatment. References remain separate from actual predictions.
Curated training examples are not an independent accuracy evaluation.

The [model pin and notices](../model/c5-winner/README.md) identify Trupan UID104's
complete C5 artifact and CC-BY-SA-4.0 license. Brand and font provenance is in
`public/ASSET-SOURCES.md`; the Quicksand license ships with the font.
