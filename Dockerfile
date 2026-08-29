# Runs the MCP server on stdio, for registries that verify a server by starting it in a
# container and asking it to introspect (Glama does this). Nothing here is needed to *use*
# citable-mcp — `npx -y citable-mcp` is the install path — and no wallet is created or read
# until a paid tool is actually called, so the image starts and lists its tools with no
# configuration and no network.
FROM oven/bun:1 AS build
WORKDIR /build
COPY package.json build.ts server.ts para.ts ./
RUN bun install --production && bun build.ts

FROM node:22-alpine
WORKDIR /app
COPY --from=build /build/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /build/dist/server.js ./dist/server.js
ENTRYPOINT ["node", "dist/server.js"]
