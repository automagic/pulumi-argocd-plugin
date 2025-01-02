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
  context: { location: "./sidecar" },
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
const provider = new k8s.Provider("k8s", {
  kubeconfig: pulumiConfig.require("kubeconfig"),
});

const ns = new k8s.core.v1.Namespace(
  "argocd-ns",
  { metadata: { name: "argocd" } },
  { provider }
);

const password = new random.RandomPassword("argo-cd-redis-password", {
  length: 16,
});

const redisSecret = new k8s.core.v1.Secret( "argo-cd-redis-secret", {
    metadata: {
      name: "argocd-redis",
      namespace: ns.metadata.name
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
    metadata: {
      name: `${pluginName}-config`,
      namespace: ns.metadata.apply((metadata) => metadata.name),
    },
    data: {
      "plugin.yaml": `
apiVersion: argoproj.io/v1alpha1
kind: ConfigManagementPlugin
metadata:
  name: ${pluginName}
spec:
  version: v1.0
  generate:
    command: [sh]
    args: [-c, 'envsubst</scripts/stack.yaml.envsubst']
  discover:
    fileName: "./Pulumi.yaml"`,
      "stack.yaml.envsubst": `
apiVersion: v1
kind: ServiceAccount
metadata:
  name: \${ARGOCD_APP_NAME}
  namespace: \${ARGOCD_APP_NAMESPACE}
  annotations:
    argocd.argoproj.io/sync-wave: "1"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: \${ARGOCD_APP_NAME}:system:auth-delegator
  annotations:
    argocd.argoproj.io/sync-wave: "2"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
- kind: ServiceAccount
  name: \${ARGOCD_APP_NAME}
  namespace: \${ARGOCD_APP_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: \${ARGOCD_APP_NAME}:cluster-admin
  annotations:
    argocd.argoproj.io/sync-wave: "2"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: \${ARGOCD_APP_NAME}
  namespace: \${ARGOCD_APP_NAMESPACE}
---
apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: \${ARGOCD_APP_NAME}
  namespace: \${ARGOCD_APP_NAMESPACE}
  annotations:
    argocd.argoproj.io/sync-wave: "3" 
    pulumi.com/reconciliation-request: "before-first-update"
    link.argocd.argoproj.io/external-link: http://api.pulumi.com/\${PARAM_PULUMI_ORG}/\${PARAM_PULUMI_PROJECT}/\${PARAM_PULUMI_STACK}
spec:
  serviceAccountName: \${ARGOCD_APP_NAME}
  stack: \${PARAM_PULUMI_ORG}/\${PARAM_PULUMI_PROJECT}/\${PARAM_PULUMI_STACK}
  projectRepo: \${ARGOCD_APP_SOURCE_REPO_URL}
  repoDir: \${ARGOCD_APP_SOURCE_PATH}
  branch: \${ARGOCD_APP_SOURCE_TARGET_REVISION}
  refresh: true
  resyncFrequencySeconds: 120
  destroyOnFinalize: true
  envRefs:
    PULUMI_ACCESS_TOKEN:
      type: Secret
      secret:
        name: pulumi-access-token-secret
        key: PULUMI_ACCESS_TOKEN
  workspaceTemplate:
    spec:
      image: pulumi/pulumi:3.134.1-nonroot
      `
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
                  key: "stack.yaml.envsubst",
                  path: "stack.yaml.envsubst",
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
    version: "7.7.12",
    values: {
      installCRDs: true,
      createClusterRoles: true,
      createAggregateRoles: true,
      server: {
        service: {
          type: "NodePort",
        },
      },
    },
  },
  { provider, dependsOn: [ns, redisSecret], transforms: [patchRepoServer] }
);

const accessTokenSecret = new k8s.core.v1.Secret(
  "pulumi-access-token",
  {
    metadata: {
      namespace: 'default',
      name: "pulumi-access-token-secret",
    },
    stringData: {
      PULUMI_ACCESS_TOKEN: pulumiConfig.require("pulumiAccessToken"),
    },
    type: "Opaque",
  },
  { provider }
);

const app = new k8s.apiextensions.CustomResource(
  "pulumi-application",
  {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: "pulumi-application",
      namespace: ns.metadata.name,
    },
    spec: {
      destination: {
        namespace: "default",
        server: "https://kubernetes.default.svc",
      },
      syncPolicy: {
        automated: {
          prune: true
        }
      },
      project: "default",
      source: {
        repoURL: "https://github.com/pulumi-initech/podinfo-ts.git",
        path: "./",
        targetRevision: "main",
        plugin: {
          parameters: [{
            name: "pulumi",
            map: { 
              "org": "initech",
              "project": "podinfo-ts",
              "stack": "test"
            }
          }],
        },
      },
    },
  },
  { provider, dependsOn: [configMap, accessTokenSecret, argocd] }
);