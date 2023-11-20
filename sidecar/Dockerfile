# Use Alpine as the base image
FROM alpine:latest

# Install curl and unzip
RUN apk add --no-cache curl unzip bash npm

# Download and install Pulumi
RUN curl -fsSL https://get.pulumi.com | \
        sh && \
        cp ~/.pulumi/bin/* /usr/local/bin

RUN adduser -u 999 -G nogroup cmp-plugin -D -s /bin/bash

# Set work directory
WORKDIR /app
