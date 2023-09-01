# Copyright (c) 2023 Siemens AG.

#--------------------------------------------------
FROM    node:lts-alpine
#--------------------------------------------------

# Tini acts like an init process, in that it is invoked with PID 1, then spawns
# a single child, and waits for it to exit all the while reaping zombies and
# performing signal forwarding.
RUN     apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

# Enable performance and security related optimizations for dependencies.
ENV     NODE_ENV=production

# TNC is running inside a Docker container.
ENV     FLOWPRO_TNC_INSIDE_DOCKER=true

RUN     mkdir -p /opt/tn-connector
WORKDIR /opt/tn-connector

# Use latest release version of deployment bundle for installation.
COPY    --chown=node:node ./deploy/tn-connector.zip .

RUN     unzip tn-connector.zip \
        && rm tn-connector.zip \
        && npm clean-install --only=production

# Create a script to copy TNC assets to a bind-mounted volume.
RUN     mkdir -p /assets \
        && chown -R node:node /assets \
        && printf "#!/bin/sh\ncp .env /assets\ncp dist/proto/* /assets\n" > assets \
        && chmod +rx assets
ENV     PATH="$PATH:/opt/tn-connector"

# Create a bind-mount point for accessing TNC assets.
VOLUME  /assets

# Default ports to be exposed.
EXPOSE  50060

# Run as an unprivileged non-root user.
USER    node

# Bake "npm start" command into the image to reduce the number of processes and
# to causes exit signals such as SIGTERM and SIGINT to be received by the
# Node.js process instead of npm swallowing them.
CMD     ["node", "-r", "dotenv/config", "dist/main.js"]
