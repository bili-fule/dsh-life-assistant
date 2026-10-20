ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
# Build context must contain only installed public packages, never DSH_HOME.
COPY runtime/node_modules /runtime/node_modules
COPY plugin-deps/node_modules /plugin-deps/node_modules
COPY debug-helper-entry.mjs debug-helper.patch.yml /app/
ENV HOME=/work NODE_OPTIONS=--max-old-space-size=192
WORKDIR /work
USER 65534:65534
ENTRYPOINT ["node","/app/debug-helper-entry.mjs"]
