# SIL mock-board — a protocol-faithful stand-in for the Gorshok-v4 firmware WS
# backend, so strawberry-cli / DeviceClient can be exercised in CI without
# hardware (the real firmware WS server is ESP-IDF/lwIP and does not run on host).
#
# Build context is the device-client package root:
#   docker build -f sil/Dockerfile -t strawberry-sil .
#   docker run --rm -p 8080:8080 strawberry-sil
#
# The mock imports the BUILT codec from ./dist, so `npm run build` must have run
# (the image build runs it). Zero runtime deps beyond Node: the WS server is a
# minimal RFC6455 implementation over node:http + node:crypto.
FROM node:20-slim

WORKDIR /app

# Install deps (protobuf-ts runtime + the build toolchain) with a reproducible
# install, then build the dist the mock imports.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY bin ./bin
COPY scripts ./scripts
COPY sil ./sil
RUN npm run build

ENV MOCK_BOARD_HOST=0.0.0.0
ENV MOCK_BOARD_PORT=8080
ENV MOCK_BOARD_PASSWORD=strawberry
EXPOSE 8080

CMD ["node", "sil/mock-board.mjs"]
