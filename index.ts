import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import * as dockerBuild from "@pulumi/docker-build";

const repository = new aws.ecr.Repository("argocd-apps");

const repositoryPolicy = new aws.ecr.RepositoryPolicy("myrepositorypolicy", {
  repository: repository.id,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "new policy",
        Effect: "Allow",
        Principal: "*",
        Action: [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeRepositories",
          "ecr:GetRepositoryPolicy",
          "ecr:ListImages",
          "ecr:DeleteRepository",
          "ecr:BatchDeleteImage",
          "ecr:SetRepositoryPolicy",
          "ecr:DeleteRepositoryPolicy",
        ],
      },
    ],
  }),
});

// Grab auth credentials for ECR.
const authToken = aws.ecr.getAuthorizationTokenOutput({
  registryId: repository.registryId,
});

const image = new dockerBuild.Image("image", {
  push: true,
  tags: [pulumi.interpolate`${repository.repositoryUrl}:latest`],
  // Use the pushed image as a cache source.
  dockerfile: {
    location: "./sidecar/Dockerfile",
  },
  platforms: ["linux/amd64"],
  cacheFrom: [
    {
      registry: {
        ref: pulumi.interpolate`${repository.repositoryUrl}:cache`,
      },
    },
  ],
  cacheTo: [
    {
      registry: {
        imageManifest: true,
        ociMediaTypes: true,
        ref: pulumi.interpolate`${repository.repositoryUrl}:cache`,
      },
    },
  ],
  // Provide our ECR credentials.
  registries: [
    {
      address: repository.repositoryUrl,
      password: authToken.password,
      username: authToken.userName,
    },
  ],
});

const pulumiConfig = new pulumi.Config();

// Existing Pulumi stack reference in the format:
const clusterStackRef = new pulumi.StackReference(
  pulumiConfig.require("clusterStackRef")
);

const provider = new k8s.Provider("k8s", {
  kubeconfig: clusterStackRef.getOutput("kubeconfig"),
  enableServerSideApply: true,
});

const ns = new k8s.core.v1.Namespace(
  "argocd-ns",
  { metadata: { name: "argocd" } },
  { provider }
);

const password = new random.RandomPassword("argo-cd-redis-password", {
  length: 16,
});

const redisSecret = new k8s.core.v1.Secret(
  "argo-cd-redis-secret",
  {
    metadata: {
      name: "argocd-redis",
      namespace: ns.metadata.apply(metadata => metadata.name),
    },
    type: "Opaque",
    stringData: {
      auth: password.result,
    },
  },
  { provider, dependsOn: [ns], retainOnDelete: true }
);

const pluginName = "pulumi-plugin";

const configMap = new k8s.core.v1.ConfigMap(
  `${pluginName}-config`,
  {
    metadata: { name: `${pluginName}-config`, namespace: ns.metadata.apply(metadata => metadata.name)},
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
export PULUMI_CONFIG_PASSPHRASE=''
pulumi login --local
if [ "false" == "$(pulumi stack ls --json | jq 'any(.[]; .name == "local")')" ]; then
  pulumi stack init local --non-interactive --logtostderr 1>&2
fi
pulumi preview --non-interactive -s local --logtostderr 1>&2`,
      "generate.sh": `
#!/bin/bash
find ./yaml -name '*.yaml' -exec cat {} +`,
    },
  },
  { provider, dependsOn: [ns] }
);

const patchRepoServer = (args: pulumi.ResourceTransformArgs) => {
  switch (args.type) {
    case "kubernetes:helm.sh/v4:Chart":
      break;
    default:
      if (
        args.type === "kubernetes:apps/v1:Deployment" &&
        args.name === "argocd:argocd/argocd-repo-server"
      ) {
        args.props.spec.template.spec.containers = [
          ...args.props.spec.template.spec.containers,
          {
            name: pluginName,
            command: ["/var/run/argocd/argocd-cmp-server"],
            image: pulumi.interpolate`${image.ref}`,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 999,
            },
            // env: [{
            //   name: 'PULUMI_ACCESS_TOKEN',
            //   valueFrom: {
            //     secretKeyRef: {
            //       name: 'pulumi-access-token',
            //       key: 'pulumi-access-token'
            //     }
            //   }
            // }],
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
                name: "config",
              },
              {
                mountPath: "/scripts",
                name: "scripts",
              },
              {
                mountPath: "/tmp",
                name: "cmp-tmp",
              },
            ],
          },
        ];

        args.props.spec.template.spec.volumes = [
          ...args.props.spec.template.spec.volumes,
          {
            name: "config",
            configMap: {
              name: pulumi.interpolate`${configMap.metadata.name}`,
              items: [
                {
                  key: "plugin.yaml",
                  path: "plugin.yaml",
                },
              ],
            },
          },
          {
            name: "scripts",
            configMap: {
              name: pulumi.interpolate`${configMap.metadata.name}`,
              defaultMode: 0o755,
              items: [
                {
                  key: "generate.sh",
                  path: "generate.sh",
                },
                {
                  key: "init.sh",
                  path: "init.sh",
                },
              ],
            },
          },
          {
            emptyDir: {},
            name: "cmp-tmp",
          },
          {
            emptyDir: {},
            name: "plugin-tools",
          },
        ];
      }
      return {
        props: args.props,
        opts: args.opts,
      };
  }
  return undefined;
};

const argocd = new k8s.helm.v4.Chart(
  "argocd",
  {
    namespace: ns.metadata.apply(metadata => metadata.name),
    chart: "argo-cd",
    repositoryOpts: {
      repo: "https://argoproj.github.io/argo-helm",
    },
    version: "7.1.3",
    values: {
//     fullnameOverride: "",
//      installCRDs: true,
//      createClusterRoles: true,
//      createAggregateRoles: true,
      server: {
        service: {
          type: "NodePort",
        },
      },
    },
  },
  { provider, dependsOn: [ns, redisSecret], transforms: [patchRepoServer] }
);

const app = new k8s.apiextensions.CustomResource(
  "pulumi-application",
  {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: "pulumi-application",
      namespace: ns.metadata.apply(metadata => metadata.name),
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
          name: "pulumi-plugin-v1.0",
        },
      },
    },
  },
  { provider, dependsOn: [ns, argocd] }
);

// export const readme = readFileSync("./Pulumi.README.md").toString();
