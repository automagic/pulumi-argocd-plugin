# pulumi-argocd-plugin


## Disclaimer
** Expiramental **  
This is intended as a thought exercise, with the intention of utilizing Pulumi in ways it is not necessarily designed to be used.


## Summary

This is a Pulumi stack which implements an ArgoCD Configuration Management Plugin (CMP), with the purpose of allowing Pulumi to be the engine which renders Kuberenets manifiests for ArgoCD.  

By default, ArgoCD supports 3 sources:  Direct kubernetes manifiest, Helm, or Kustomize:  

![The ArgoCD rederning pipeline](image.png)

We propose to add a Pulumi as a 4th option.

This is similar in spirit to the Pulumi Kubernetes Operator, but using ArgoCD navtively. 

By utilzing the CMP plugin framework described here: https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/ we can inject a sidecar to deploy ArgoCD Applications against repositories containing valid Pulumi kubernetes programs.  


# Usage
Here is an example of a valid program, which deploys a single pod:

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

let providerConfig: k8s.ProviderArgs = {};

const config = new pulumi.Config();

if (config.get("renderToDirectory")) {
  providerConfig = {
    renderYamlToDirectory: config.get("renderToDirectory"),
    ...providerConfig,
  };
}

const k8sProvider = new k8s.Provider("yaml-provider", providerConfig);

const pod = new k8s.core.v1.Pod("my-pod", {
    spec: {
        containers: [{
            name: "nginx",
            image: "nginx:1.14-alpine",
        }],
    },
}, {provider: k8sProvider});  
```

By using `renderYamlToDirectory` flag, we enable ArgoCD to be responsible for deploying the application manifiests to the cluster, and maintinaing the application lifecycle.

The following ArgoCD Application manifest is installed in the cluster, notifying ArgoCD to monitor and deploy the program from a GitHub repo:

```typescript
const app = new k8s.apiextensions.CustomResource("pulumi-application", {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
        namespace: "argocd",
        name: "pulumi-application"
    },
    spec: {
        destination: {
            namespace: "default",
            server: "https://kubernetes.default.svc",
        },
        project: "default",
        source: {
            repoURL: "https://github.com/automagic/pulumi_k8s_app.git",
            path: "./",
            targetRevision: "main",
            plugin: {
                name: 'pulumi-plugin-v1.0'
            }
        }
    },
});
```

Note the `plugin` declaration under `source`, telling ArgoCD to use our sidecar to render the manifests.

![Rendered Application](image-1.png)

# How it works

Essentially, we declare a configuration `ConfigMap` which describes to ArgoCD how to run our plugin:

```typescript

const configMap = new k8s.core.v1.ConfigMap( `${pluginName}-config`, {
    metadata: { name: `${pluginName}-config`, namespace: "argocd" },
    data: {
      "plugin.yaml": `
apiVersion: argoproj.io/v1alpha1
kind: ConfigManagementPlugin
metadata:
  name: ${pluginName}
spec:
  version: v1.0
  init:
    command: [sh, -c, /scripts/init.sh]
  generate:
    command: [sh, -c, /scripts/generate.sh]`,
      "init.sh": `
#!/bin/bash
npm ci
pulumi login --local
pulumi down -y --non-interactive -s dev
pulumi up -f -y --non-interactive -s dev`,
      "generate.sh": `
#!/bin/bash
find ./yaml -name '*.yaml' -exec cat {} +`,
    },
  },
  { provider, dependsOn: [ns] }
);
```

This ConfigMap has 3 entries:
1. `plugin.yaml` which contains the plugin config, specifying shell commands to run during `init` and `generate` (manifest) steps.  
2. `init.sh` which specifies commands to run to prepare for manifest generation. 
3. `generate.sh` which has the responsibility of rendering the manifests to `stdout`.


Next, we patch `argocd-repo-server` Deployment, adding a sidecar to the pod, which contains the pulumi binary.  Addtionally, here we reference the ConfigMap above, to mount the scripts into the container.

``` typescript
const deploymentPatch = new k8s.apps.v1.DeploymentPatch(
  `${deploymentName}-patch`,
  {
    metadata: {
      name: deployment.metadata.name,
      namespace: deployment.metadata.namespace,
    },
    spec: {
      template: {
        spec: {
          containers: deployment.spec.template.spec.containers.apply( containers => [
            ...containers,
            {
              name: pluginName,
              command: ["/var/run/argocd/argocd-cmp-server"],
              image: pulumi.interpolate`${image.imageUri}`,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 999
              },
              env: [{
                name: 'PULUMI_ACCESS_TOKEN',
                value: 'pul-7274d7b8df3ee755eb575498eea30ca34f3e1f22'      
              }],
              volumeMounts: [
                {
                  mountPath: "/var/run/argocd",
                  name: "var-files",
                },
                {
                  mountPath: "/home/argocd/cmp-server/plugins",
                  name: "plugins",
                },
                {
                  mountPath: "/home/argocd/cmp-server/config",
                  name: "config"
                },
                {
                  mountPath: "/scripts",
                  name: 'scripts',
                },
                {
                  mountPath: "/tmp",
                  name: "cmp-tmp",
                },
              ],
            }, 
          ]),
          volumes: deployment.spec.template.spec.volumes.apply( volumes => [
            ...volumes,
            {
              name: 'config',
              configMap: {
                name: pulumi.interpolate`${configMap.metadata.name}`,
                items: [{ 
                    key: 'plugin.yaml',
                    path: 'plugin.yaml'
                }]
              }
            },
            {
                name: 'scripts',
                configMap: {
                  name: pulumi.interpolate`${configMap.metadata.name}`,
                  defaultMode: 0o755,
                  items: [{ 
                      key: 'generate.sh',
                      path: 'generate.sh'
                  },{ 
                    key: 'init.sh',
                    path: 'init.sh'
                  }]
                }
            },
            {
              emptyDir: {},
              name: "cmp-tmp",
            },
            {
              emptyDir: {},
              name: "plugin-tools",
            },
          ]),
        },
      },
    },
  },
  { provider }
);

```

Last, we define a basic container image and deploy it to ECR, setting up the Pulumi runtime environment:

Note the special user 999, required by ArgoCD CMP framework.
```docker
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
```


# Difficulties

- The entire stack is rendered in the plugin, and the logs are not displayed well within ArgoCD.  If resources outside the scope of @pulumi/kubernetes were preset, they would be created.  It would not be advised to have the stack manage other resources besides the manifesst files themselves in this pattern.

- Pulumi does not allow for recreation of the manifest files as specified in `renderYamlToDirectory`, if the pulumi stack is managed centrally.  However, the plugin needs the manifests to be re-rendered.  Working around this by destroying and recreating the stack every time.

- It would be easier to implement, if there was a Pulumi flag to render these manifests to a stream such as stdout, instead of just to a directory.