import {Flags} from '@oclif/core';
import Command from '@shopify/cli-kit/node/base-command';
import colors from '@shopify/cli-kit/node/colors';
import {
  outputContent,
  outputInfo,
  outputWarn,
} from '@shopify/cli-kit/node/output';
import {readAndParseDotEnv} from '@shopify/cli-kit/node/dot-env';
import {AbortError} from '@shopify/cli-kit/node/error';
import {writeFile} from '@shopify/cli-kit/node/fs';
import {
  ensureIsClean,
  getLatestGitCommit,
  GitDirectoryNotCleanError,
} from '@shopify/cli-kit/node/git';
import {relativePath, resolvePath} from '@shopify/cli-kit/node/path';
import {
  renderSelectPrompt,
  renderSuccess,
  renderTasks,
  renderWarning,
} from '@shopify/cli-kit/node/ui';
import {Logger, LogLevel} from '@shopify/cli-kit/node/output';
import {ciPlatform} from '@shopify/cli-kit/node/context/local';
import {
  CompletedDeployment,
  createDeploy,
  DeploymentConfig,
  DeploymentHooks,
  DeploymentVerificationDetailsResponse,
  parseToken,
} from '@shopify/oxygen-cli/deploy';

import {commonFlags, flagsToCamelObject} from '../../lib/flags.js';
import {getOxygenDeploymentData} from '../../lib/get-oxygen-deployment-data.js';
import {OxygenDeploymentData} from '../../lib/graphql/admin/get-oxygen-data.js';
import {runBuild} from './build.js';
import {runViteBuild} from './build-vite.js';
import {getViteConfig} from '../../lib/vite-config.js';
import {prepareDiffDirectory} from '../../lib/template-diff.js';

const DEPLOY_OUTPUT_FILE_HANDLE = 'h2_deploy_log.json';

export const deploymentLogger: Logger = (
  message: string,
  level: LogLevel = 'info',
) => {
  if (level === 'error' || level === 'warn') {
    outputWarn(message);
  }
};

export default class Deploy extends Command {
  static description = 'Builds and deploys a Hydrogen storefront to Oxygen.';
  static flags: any = {
    'env-branch': Flags.string({
      description: 'Environment branch (tag) for environment to deploy to.',
      required: false,
    }),
    'env-file': Flags.string({
      description:
        'Path to an environment file to override existing environment variables for the deployment.',
      required: false,
    }),
    preview: Flags.boolean({
      description:
        'Deploys to the Preview environment. Overrides --env-branch and Git metadata.',
      required: false,
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description:
        'Forces a deployment to proceed if there are uncommited changes in its Git repository.',
      default: false,
      env: 'SHOPIFY_HYDROGEN_FLAG_FORCE',
      required: false,
    }),
    'no-verify': Flags.boolean({
      description: 'Skip the routability verification step after deployment.',
      default: false,
      required: false,
    }),
    'auth-bypass-token': Flags.boolean({
      description:
        'Generate an authentication bypass token, which can be used to perform end-to-end tests against the deployment.',
      required: false,
      default: false,
    }),
    'build-command': Flags.string({
      description:
        'Specify a build command to run before deploying. If not specified, `shopify hydrogen build` will be used.',
      required: false,
    }),
    ...commonFlags.lockfileCheck,
    ...commonFlags.path,
    ...commonFlags.shop,
    'json-output': Flags.boolean({
      allowNo: true,
      description:
        'Create a JSON file containing the deployment details in CI environments. Defaults to true, use `--no-json-output` to disable.',
      required: false,
      default: true,
    }),
    token: Flags.string({
      char: 't',
      description:
        "Oxygen deployment token. Defaults to the linked storefront's token if available.",
      env: 'SHOPIFY_HYDROGEN_DEPLOYMENT_TOKEN',
      required: false,
    }),
    'metadata-description': Flags.string({
      description:
        'Description of the changes in the deployment. Defaults to the commit message of the latest commit if there are no uncommited changes.',
      required: false,
      env: 'SHOPIFY_HYDROGEN_FLAG_METADATA_DESCRIPTION',
    }),
    'metadata-url': Flags.string({
      required: false,
      env: 'SHOPIFY_HYDROGEN_FLAG_METADATA_URL',
      hidden: true,
    }),
    'metadata-user': Flags.string({
      description:
        'User that initiated the deployment. Will be saved and displayed in the Shopify admin',
      required: false,
      env: 'SHOPIFY_HYDROGEN_FLAG_METADATA_USER',
    }),
    'metadata-version': Flags.string({
      required: false,
      env: 'SHOPIFY_HYDROGEN_FLAG_METADATA_VERSION',
      hidden: true,
    }),
    ...commonFlags.diff,
  };

  async run() {
    const {flags} = await this.parse(Deploy);
    const deploymentOptions = this.flagsToOxygenDeploymentOptions(flags);

    if (flags.diff) {
      deploymentOptions.path = await prepareDiffDirectory(
        deploymentOptions.path,
        false,
      );
    }

    await runDeploy(deploymentOptions);

    // The Remix compiler hangs due to a bug in ESBuild:
    // https://github.com/evanw/esbuild/issues/2727
    // The actual build has already finished so we can kill the process
    process.exit(0);
  }

  private flagsToOxygenDeploymentOptions(flags: {
    [x: string]: any;
  }): OxygenDeploymentOptions {
    const camelFlags = flagsToCamelObject(flags);
    return {
      ...camelFlags,
      defaultEnvironment: flags.preview,
      environmentTag: flags['env-branch'],
      environmentFile: flags['env-file'],
      path: flags.path ? resolvePath(flags.path) : process.cwd(),
    } as OxygenDeploymentOptions;
  }
}

interface OxygenDeploymentOptions {
  authBypassToken: boolean;
  buildCommand?: string;
  defaultEnvironment: boolean;
  environmentTag?: string;
  environmentFile?: string;
  force: boolean;
  noVerify: boolean;
  lockfileCheck: boolean;
  jsonOutput: boolean;
  path: string;
  shop: string;
  token?: string;
  metadataDescription?: string;
  metadataUrl?: string;
  metadataUser?: string;
  metadataVersion?: string;
}

interface GitCommit {
  refs: string;
  hash: string;
}

function createUnexpectedAbortError(message?: string): AbortError {
  return new AbortError(
    message || 'The deployment failed due to an unexpected error.',
    'Retrying the deployment may succeed.',
    [
      [
        'If the issue persists, please check the',
        {
          link: {
            label: 'Shopify status page',
            url: 'https://status.shopify.com/',
          },
        },
        'for any known issues.',
      ],
    ],
  );
}

export async function runDeploy(
  options: OxygenDeploymentOptions,
): Promise<void> {
  const {
    authBypassToken: generateAuthBypassToken,
    buildCommand,
    defaultEnvironment,
    environmentTag,
    environmentFile,
    force: forceOnUncommitedChanges,
    noVerify,
    lockfileCheck,
    jsonOutput,
    path: root,
    shop,
    metadataUrl,
    metadataUser,
    metadataVersion,
  } = options;
  let {metadataDescription} = options;

  let isCleanGit = true;
  try {
    await ensureIsClean(root);
  } catch (error) {
    if (error instanceof GitDirectoryNotCleanError) {
      isCleanGit = false;
    }

    if (!forceOnUncommitedChanges && !isCleanGit) {
      throw new AbortError('Uncommitted changes detected.', null, [
        [
          'Commit your changes before deploying or use the ',
          {command: '--force'},
          ' flag to deploy with uncommitted changes.',
        ],
      ]);
    }
  }

  const isCI = ciPlatform().isCI;
  let token = options.token;
  let branch: string | undefined | null;
  let commitHash: string | undefined;
  let deploymentData: OxygenDeploymentData | undefined;
  let deploymentEnvironmentTag: string | undefined | null = undefined;
  let gitCommit: GitCommit;

  try {
    gitCommit = await getLatestGitCommit(root);
    branch = (/HEAD -> ([^,]*)/.exec(gitCommit.refs) || [])[1];
    commitHash = gitCommit.hash;
  } catch (error) {
    outputWarn('Could not retrieve Git history.');
    branch = undefined;
  }

  if (!metadataDescription && !isCleanGit) {
    renderWarning({
      headline: 'No deployment description provided',
      body: [
        'Deploying uncommited changes, but no description has been provided. Use the ',
        {command: '--metadata-description'},
        'flag to provide a description. If no description is provided, the description defaults to ',
        {userInput: '<sha> with additional changes'},
        ' using the SHA of the last commit.',
      ],
    });
    metadataDescription = `${commitHash} with additional changes`;
  }

  let overriddenEnvironmentVariables;

  if (environmentFile) {
    const {variables} = await readAndParseDotEnv(environmentFile);
    overriddenEnvironmentVariables = Object.entries(variables).map(
      ([key, value]) => ({
        isSecret: true,
        key,
        value,
      }),
    );
  }

  if (!isCI) {
    deploymentData = await getOxygenDeploymentData({
      root,
      flagShop: shop,
    });

    if (!deploymentData) {
      return;
    }

    token = token || deploymentData.oxygenDeploymentToken;
  }

  if (!token) {
    const errMessage = isCI
      ? [
          'No deployment token provided. Use the ',
          {command: '--token'},
          ' flag to provide a token.',
        ]
      : `Could not obtain an Oxygen deployment token, please try again or contact Shopify support.`;
    throw new AbortError(errMessage);
  }

  if (
    !isCI &&
    !defaultEnvironment &&
    !environmentTag &&
    deploymentData?.environments
  ) {
    if (deploymentData.environments.length > 1) {
      const choices = [
        ...deploymentData.environments.map(({name, branch, type}) => ({
          label: name,
          // The preview environment will never have an associated branch so
          // we're using a custom string here to identify it later in our code.
          // Using a period at the end of the value is an invalid branch name
          // in Git so we can be sure that this won't conflict with a merchant's
          // repository.
          value: type === 'PREVIEW' ? 'shopify-preview-environment.' : branch,
        })),
      ];

      deploymentEnvironmentTag = await renderSelectPrompt({
        message: 'Select an environment to deploy to',
        choices,
        defaultValue: branch,
      });
    } else {
      outputInfo(
        `Using current checked out branch ${branch} as environment tag`,
      );
    }
  }

  let deploymentUrl = 'https://oxygen.shopifyapps.com';
  if (process.env.UNSAFE_SHOPIFY_HYDROGEN_DEPLOYMENT_URL) {
    deploymentUrl = process.env.UNSAFE_SHOPIFY_HYDROGEN_DEPLOYMENT_URL;
    outputWarn(
      "Using a custom deployment service. Don't do this in production!",
    );
  }

  let fallbackEnvironmentTag = branch;
  let isPreview = false;

  // If the user has explicitly selected `Preview` then we should not pass an
  // environment tag at all.
  if (deploymentEnvironmentTag === 'shopify-preview-environment.') {
    fallbackEnvironmentTag = undefined;
    deploymentEnvironmentTag = undefined;
    isPreview = true;
  }

  let assetsDir = 'dist/client';
  let workerDir = 'dist/worker';

  const maybeVite = await getViteConfig(root).catch(() => null);

  if (maybeVite) {
    assetsDir = relativePath(root, maybeVite.clientOutDir);
    workerDir = relativePath(root, maybeVite.serverOutDir);
  }

  const config: DeploymentConfig = {
    assetsDir,
    bugsnag: true,
    deploymentUrl,
    defaultEnvironment: defaultEnvironment || isPreview,
    deploymentToken: parseToken(token as string),
    environmentTag:
      environmentTag || deploymentEnvironmentTag || fallbackEnvironmentTag,
    generateAuthBypassToken,
    verificationMaxDuration: 180,
    metadata: {
      ...(metadataDescription ? {description: metadataDescription} : {}),
      ...(metadataUrl ? {url: metadataUrl} : {}),
      ...(metadataUser ? {user: metadataUser} : {}),
      ...(metadataVersion ? {version: metadataVersion} : {}),
    },
    skipVerification: noVerify,
    rootPath: root,
    skipBuild: false,
    workerOnly: false,
    workerDir,
    overriddenEnvironmentVariables,
  };

  let resolveUpload: () => void;
  const uploadPromise = new Promise<void>((resolve) => {
    resolveUpload = resolve;
  });

  let resolveRoutableCheck: () => void;
  const routableCheckPromise = new Promise<void>((resolve) => {
    resolveRoutableCheck = resolve;
  });

  let resolveDeploymentCompletedVerification: () => void;
  const deploymentCompletedVerificationPromise = new Promise<void>(
    (resolve) => {
      resolveDeploymentCompletedVerification = resolve;
    },
  );

  let deployError: AbortError | null = null;
  let resolveDeploy: () => void;
  let rejectDeploy: (reason?: AbortError) => void;
  const deployPromise = new Promise<void>((resolve, reject) => {
    resolveDeploy = resolve;
    rejectDeploy = reject;
  });

  const hooks: DeploymentHooks = {
    onDeploymentCompleted: () => resolveDeploymentCompletedVerification(),
    onVerificationComplete: () => resolveRoutableCheck(),
    onDeploymentCompletedVerificationError() {
      deployError = new AbortError(
        'Unable to verify the deployment was completed successfully',
        'Please verify the deployment status in the Shopify Admin and retry deploying if necessary.',
      );
    },
    onDeploymentFailed: (details: DeploymentVerificationDetailsResponse) => {
      deployError = createUnexpectedAbortError(details.error || details.status);
    },
    onUploadFilesStart: () => uploadStart(),
    onUploadFilesComplete: () => resolveUpload(),
    onVerificationError: (error: Error) => {
      deployError = new AbortError(
        error.message,
        'Please verify the deployment status in the Shopify Admin and retry deploying if necessary.',
      );
    },
    onUploadFilesError: (error: Error) => {
      deployError = new AbortError(
        error.message,
        'Check your connection and try again. If the problem persists, try again later or contact support.',
      );
    },
  };

  if (buildCommand) {
    config.buildCommand = buildCommand;
  } else {
    hooks.buildFunction = async (
      assetPath: string | undefined,
    ): Promise<void> => {
      outputInfo(
        outputContent`${colors.whiteBright('Building project...')}`.value,
      );

      const build = maybeVite ? runViteBuild : runBuild;

      await build({
        directory: root,
        assetPath,
        lockfileCheck,
        sourcemap: true,
        useCodegen: false,
      });
    };
  }

  const uploadStart = async () => {
    outputInfo(
      outputContent`${colors.whiteBright('Deploying to Oxygen..\n')}`.value,
    );
    await renderTasks([
      {
        title: 'Uploading files',
        task: async () => await uploadPromise,
      },
      {
        title: 'Verifying deployment has been completed',
        task: async () => await deploymentCompletedVerificationPromise,
      },
      {
        title: 'Verifying deployment is routable',
        task: async () => await routableCheckPromise,
        skip: () => noVerify,
      },
    ]);
  };

  await createDeploy({config, hooks, logger: deploymentLogger})
    .then(async (completedDeployment: CompletedDeployment | undefined) => {
      if (!completedDeployment) {
        rejectDeploy(createUnexpectedAbortError());
        return;
      }

      const nextSteps: (
        | string
        | {subdued: string}
        | {link: {url: string}}
      )[][] = [];

      if (isCI) {
        if (jsonOutput) {
          nextSteps.push([
            'View the deployment information in',
            {subdued: DEPLOY_OUTPUT_FILE_HANDLE},
          ]);
        }
      } else {
        nextSteps.push([
          'Open',
          {link: {url: completedDeployment!.url}},
          'in your browser to view your deployment.',
        ]);

        if (completedDeployment?.authBypassToken) {
          nextSteps.push([
            'Use the',
            {subdued: completedDeployment.authBypassToken},
            'token to perform end-to-end tests against the deployment.',
          ]);
        }
      }

      renderSuccess({
        body: ['Successfully deployed to Oxygen'],
        nextSteps,
      });
      // in CI environments, output to a file so consequent steps can access the deployment details
      if (isCI && jsonOutput) {
        await writeFile(
          DEPLOY_OUTPUT_FILE_HANDLE,
          JSON.stringify(completedDeployment),
        );
      }
      resolveDeploy();
    })
    .catch((error) => {
      rejectDeploy(deployError || error);
    });

  return deployPromise;
}
