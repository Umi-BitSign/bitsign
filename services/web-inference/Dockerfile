# Load the verified public runtime archive with model/c5-winner/fetch.sh first.
# Its signed UMI runtime identity is pinned in model/c5-winner/pin.json. The OCI
# transport manifest is a separate identity, pinned here by immutable digest.
FROM bitsign-c5-runtime:f025ceb38cacc5c71873d94b8f2010aae10a0193a0e410e410a202f4def3b7b0@sha256:4a7b543559506e7b8c83605d1676c114b06710e287a2349e89c0d995d093f8ec
USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 && \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 model/c5-winner/artifact/model/ /model/
COPY --chmod=0444 model/c5-winner/manifest.json model/c5-winner/pin.json services/web-inference/verify_model.py /app/
RUN python /app/verify_model.py /model /app/manifest.json /app/pin.json > /app/verification.json && \
    chmod 0444 /app/verification.json && chmod 0555 /app
COPY --chmod=444 services/web-inference/server.py services/web-inference/warm_worker.py services/web-inference/warm_worker_client.py services/web-inference/admit_video.py /app/
USER 65532:65532
EXPOSE 8080
WORKDIR /app
ENV UMI_EVALUATION_DEVICE=cpu OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1
ENTRYPOINT ["/usr/local/bin/python3", "-B", "/app/server.py"]
