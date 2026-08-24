FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build:all
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

COPY --from=build /app/examples/fonts /usr/local/share/fonts/pluma

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap util-linux tini ca-certificates fontconfig \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/cloud/package.json ./apps/cloud/package.json
COPY --from=build /app/apps/cloud/dist ./apps/cloud/dist
COPY --from=build /app/apps/cloud/migrations ./apps/cloud/migrations
COPY --from=build /app/LICENSE /app/NOTICE ./
COPY --from=build /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES

RUN chown -R node:node /app

USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/cloud/dist/server/index.js"]
