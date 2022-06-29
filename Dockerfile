FROM node:16-alpine

WORKDIR /opt/ProtoVerse/

COPY . .

RUN npm install --production

# The node user (from node:16-alpine) has UID 1000, meaning most people with single-user systems will not have to change UID
USER node

VOLUME /opt/ProtoVerse/data/

ENTRYPOINT /usr/local/bin/npm start -- -c data/settings.yaml
