import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { readFileSync } from "fs";
import * as operator from "./operator";

const repository = new aws.ecr.Repository("argocd-apps");

const repositoryPolicy = new aws.ecr.RepositoryPolicy("myrepositorypolicy", {
    repository: repository.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
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
                "ecr:DeleteRepositoryPolicy"
            ]
        }]
    })
});

const image = new awsx.ecr.Image("argocd-pulumi-sidecar", {
    repositoryUrl: repository.repositoryUrl,
    platform: 'linux/amd64',
    dockerfile: "./sidecar/Dockerfile"
});

const pulumiConfig = new pulumi.Config();

// Existing Pulumi stack reference in the format:
const clusterStackRef = new pulumi.StackReference(
  pulumiConfig.require("clusterStackRef")
);

const provider = new k8s.Provider("k8s", {
  kubeconfig: clusterStackRef.getOutput("kubeconfig"),
  enableServerSideApply: true
});

// const pulumiNS = new k8s.core.v1.Namespace( "pulumi-ns", { metadata: { name: "pulumi" }, }, { provider });

const pulumiOperator = new operator.PulumiKubernetesOperator('pulumi-operator', {
  namespace: 'default',
  provider,
});

const ns = new k8s.core.v1.Namespace( "argocd-ns", { metadata: { name: "argocd" }, }, { provider });

const argocd = new k8s.helm.v3.Chart( "argocd", {
    namespace:  pulumi.interpolate`${ns.metadata.name}`,
    chart: "argo-cd",
    fetchOpts: { 
      repo: "https://argoproj.github.io/argo-helm", 
      version: '5.51.4' 
    },
    values: {
      installCRDs: true,
      createClusterRoles: true,
      createAggregateRoles: true,
      server: {
        service: {
          type: "NodePort",
        },
      },
      configs: {
        params: {
          "application.namespaces": "*"
        }
      }
    },
    // The helm chart is using a deprecated apiVersion,
    // So let's transform it
    transformations: [
      (obj: any) => {
        if (obj.apiVersion == "extensions/v1beta1") {
          obj.apiVersion = "networking.k8s.io/v1beta1";
        }
      },
    ],
  },
  { providers: { kubernetes: provider }, dependsOn: [ns] }
);

const pluginName = "pulumi-plugin";

// const configMap = new k8s.core.v1.ConfigMap( `${pluginName}-config`, {
//     metadata: { name: `${pluginName}-config`, namespace: "argocd" },
//     data: {
//       "plugin.yaml": `
// apiVersion: argoproj.io/v1alpha1
// kind: ConfigManagementPlugin
// metadata:
//   name: ${pluginName}
// spec:
//   version: v1.0
//   init:
//     command: [sh, -c, /scripts/init.sh]
//   generate:
//     command: [sh, -c, /scripts/generate.sh]`,
//       "init.sh": `
// #!/bin/bash
// npm ci
// pulumi down -y --non-interactive -s team-ce/dev --logtostderr 1>&2 
// pulumi up -f -y --non-interactive -s team-ce/dev --logtostderr 1>&2`,
//       "generate.sh": `
// #!/bin/bash
// find ./yaml -name '*.yaml' -exec cat {} +`,
//     },
//   },
//   { provider, dependsOn: [ns] }
// );

const configMapStack = new k8s.core.v1.ConfigMap( `${pluginName}-config-stack`, {
  metadata: { name: `${pluginName}-config-stack`, namespace: "argocd" },
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
echo "Initializing..."
`,
    "generate.sh": `
#!/bin/bash
cat <<EOF 
apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: $ARGOCD_APP_NAME
  namespace: $ARGOCD_APP_NAMESPACE
spec:
  envRefs:
    PULUMI_ACCESS_TOKEN:
      type: Secret
      secret:
        name: pulumi-access-token
        key: pulumi-access-token
  stack: $ARGOCD_ENV_STACK
  projectRepo: $ARGOCD_APP_SOURCE_REPO_URL
  repoDir: $ARGOCD_APP_SOURCE_PATH
  commit: $ARGOCD_APP_REVISION
  initOnCreate: true
  destroyOnFinalize: true
EOF`,
    },
  },
  { provider, dependsOn: [ns] }
);

const deploymentName = "argocd-repo-server";
let deployment = argocd.getResource("apps/v1/Deployment", "argocd", deploymentName);

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
                valueFrom: {
                  secretKeyRef: {
                    name: 'pulumi-access-token',
                    key: 'pulumi-access-token'
                  }
                }
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
                name: pulumi.interpolate`${configMapStack.metadata.name}`,
                items: [{ 
                    key: 'plugin.yaml',
                    path: 'plugin.yaml'
                }]
              }
            },
            {
                name: 'scripts',
                configMap: {
                  name: pulumi.interpolate`${configMapStack.metadata.name}`,
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

const app = new k8s.apiextensions.CustomResource("pulumi-application", {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
        namespace:  pulumi.interpolate`${ns.metadata.name}`,
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
                name: 'pulumi-plugin-v1.0',
                env: [{
                  name: 'STACK',
                  value: 'team-ce/app/dev'
                }]
            }
        }
    },
}, {provider, dependsOn: [deploymentPatch]});


export const readme = readFileSync("./Pulumi.README.md").toString();