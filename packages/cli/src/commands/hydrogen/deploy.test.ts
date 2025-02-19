import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {type AdminSession, login} from '../../lib/auth.js';
import {getStorefronts} from '../../lib/graphql/admin/link-storefront.js';
import {readAndParseDotEnv} from '@shopify/cli-kit/node/dot-env';
import {AbortError} from '@shopify/cli-kit/node/error';
import {writeFile} from '@shopify/cli-kit/node/fs';
import {
  renderSelectPrompt,
  renderFatalError,
  renderSuccess,
  renderWarning,
} from '@shopify/cli-kit/node/ui';
import {
  ensureIsClean,
  getLatestGitCommit,
  GitDirectoryNotCleanError,
} from '@shopify/cli-kit/node/git';

import {deploymentLogger, runDeploy} from './deploy.js';
import {getOxygenDeploymentData} from '../../lib/get-oxygen-deployment-data.js';
import {
  CompletedDeployment,
  createDeploy,
  parseToken,
} from '@shopify/oxygen-cli/deploy';
import {ciPlatform} from '@shopify/cli-kit/node/context/local';
import {runBuild} from './build.js';

vi.mock('@shopify/oxygen-cli/deploy');
vi.mock('@shopify/cli-kit/node/dot-env');
vi.mock('@shopify/cli-kit/node/fs');
vi.mock('@shopify/cli-kit/node/context/local');
vi.mock('../../lib/get-oxygen-deployment-data.js');
vi.mock('./build.js');
vi.mock('../../lib/auth.js');
vi.mock('../../lib/shopify-config.js');
vi.mock('../../lib/graphql/admin/link-storefront.js');
vi.mock('../../lib/graphql/admin/create-storefront.js');
vi.mock('../../lib/graphql/admin/fetch-job.js');
vi.mock('../../lib/shell.js', () => ({getCliCommand: () => 'h2'}));
vi.mock('@shopify/cli-kit/node/output', async () => {
  return {
    outputContent: () => ({value: ''}),
    outputInfo: () => {},
    outputWarn: () => {},
  };
});
vi.mock('@shopify/cli-kit/node/ui', async () => {
  return {
    renderFatalError: vi.fn(),
    renderSelectPrompt: vi.fn(),
    renderSuccess: vi.fn(),
    renderTasks: vi.fn(),
    renderWarning: vi.fn(),
  };
});
vi.mock('@shopify/cli-kit/node/git', async () => {
  const actual = await vi.importActual('@shopify/cli-kit/node/git');
  return {
    ...(actual as object),
    getLatestGitCommit: vi.fn(),
    ensureIsClean: vi.fn(),
  };
});

describe('deploy', () => {
  const ADMIN_SESSION: AdminSession = {
    token: 'abc123',
    storeFqdn: 'my-shop.myshopify.com',
  };

  const FULL_SHOPIFY_CONFIG = {
    shop: 'my-shop.myshopify.com',
    shopName: 'My Shop',
    email: 'email',
    storefront: {
      id: 'gid://shopify/HydrogenStorefront/1',
      title: 'Hydrogen',
    },
  };

  const UNLINKED_SHOPIFY_CONFIG = {
    ...FULL_SHOPIFY_CONFIG,
    storefront: undefined,
  };
  const originalExit = process.exit;

  const deployParams = {
    authBypassToken: true,
    defaultEnvironment: false,
    force: false,
    noVerify: true,
    lockfileCheck: false,
    jsonOutput: true,
    path: './',
    shop: 'snowdevil.myshopify.com',
    metadataUrl: 'https://example.com',
    metadataUser: 'user',
    metadataVersion: '1.0.0',
  };

  const mockToken = {
    accessToken: 'some-token',
    allowedResource: 'some-resource',
    appId: '1',
    client: '1',
    expiresAt: 'some-time',
    namespace: 'some-namespace',
    namespaceId: '1',
  };

  const expectedConfig = {
    assetsDir: 'dist/client',
    bugsnag: true,
    defaultEnvironment: false,
    deploymentUrl: 'https://oxygen.shopifyapps.com',
    deploymentToken: mockToken,
    generateAuthBypassToken: true,
    verificationMaxDuration: 180,
    metadata: {
      url: deployParams.metadataUrl,
      user: deployParams.metadataUser,
      version: deployParams.metadataVersion,
    },
    skipVerification: true,
    rootPath: deployParams.path,
    skipBuild: false,
    workerOnly: false,
    workerDir: 'dist/worker',
  };

  const expectedHooks = {
    buildFunction: expect.any(Function),
    onDeploymentCompleted: expect.any(Function),
    onDeploymentFailed: expect.any(Function),
    onDeploymentCompletedVerificationError: expect.any(Function),
    onVerificationComplete: expect.any(Function),
    onVerificationError: expect.any(Function),
    onUploadFilesStart: expect.any(Function),
    onUploadFilesComplete: expect.any(Function),
    onUploadFilesError: expect.any(Function),
  };

  beforeEach(async () => {
    process.exit = vi.fn() as any;
    vi.mocked(login).mockResolvedValue({
      session: ADMIN_SESSION,
      config: UNLINKED_SHOPIFY_CONFIG,
    });
    vi.mocked(ciPlatform).mockReturnValue({isCI: false});
    vi.mocked(getStorefronts).mockResolvedValue([
      {
        ...FULL_SHOPIFY_CONFIG.storefront,
        parsedId: '1',
        productionUrl: 'https://example.com',
      },
    ]);
    vi.mocked(renderSelectPrompt).mockResolvedValue(FULL_SHOPIFY_CONFIG.shop);
    vi.mocked(createDeploy).mockResolvedValue({
      authBypassToken: 'some-token',
      url: 'https://a-lovely-deployment.com',
    });
    vi.mocked(getOxygenDeploymentData).mockResolvedValue({
      oxygenDeploymentToken: 'some-encoded-token',
      environments: [],
    });
    vi.mocked(parseToken).mockReturnValue(mockToken);
  });

  afterEach(() => {
    vi.resetAllMocks();
    process.exit = originalExit;
  });

  it('calls getOxygenDeploymentData with the correct parameters', async () => {
    await runDeploy(deployParams);
    expect(getOxygenDeploymentData).toHaveBeenCalledWith({
      root: './',
      flagShop: 'snowdevil.myshopify.com',
    });
    expect(getOxygenDeploymentData).toHaveBeenCalledTimes(1);
  });

  it('calls createDeploy with the correct parameters', async () => {
    await runDeploy(deployParams);

    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: expectedConfig,
      hooks: expectedHooks,
      logger: deploymentLogger,
    });
    expect(vi.mocked(renderSuccess)).toHaveBeenCalled;
  });

  it('calls createDeploy with overridden variables in environment file', async () => {
    vi.mocked(readAndParseDotEnv).mockResolvedValue({
      path: 'fake-env-file',
      variables: {
        'fake-key': 'fake-value',
      },
    });

    await runDeploy({
      ...deployParams,
      environmentFile: 'fake-env-file',
    });

    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: {
        ...expectedConfig,
        overriddenEnvironmentVariables: [
          {
            key: 'fake-key',
            value: 'fake-value',
            isSecret: true,
          },
        ],
      },
      hooks: expectedHooks,
      logger: deploymentLogger,
    });
  });

  it('errors when there are uncommited changes', async () => {
    vi.mocked(ensureIsClean).mockRejectedValue(
      new GitDirectoryNotCleanError('Uncommitted changes'),
    );
    await expect(runDeploy(deployParams)).rejects.toThrowError(
      'Uncommitted changes detected',
    );
    expect(vi.mocked(createDeploy)).not.toHaveBeenCalled;
  });

  it('proceeds with warning and modified description when there are uncommited changes and the force flag is used', async () => {
    vi.mocked(ensureIsClean).mockRejectedValue(
      new GitDirectoryNotCleanError('Uncommitted changes'),
    );
    vi.mocked(getLatestGitCommit).mockResolvedValue({
      hash: '123',
      message: 'test commit',
      date: '2021-01-01',
      author_name: 'test author',
      author_email: 'test@author.com',
      body: 'test body',
      refs: 'HEAD -> main',
    });

    await runDeploy({
      ...deployParams,
      force: true,
    });

    expect(vi.mocked(renderWarning)).toHaveBeenCalledWith({
      headline: 'No deployment description provided',
      body: expect.anything(),
    });
    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: {
        ...expectedConfig,
        environmentTag: 'main',
        metadata: {
          ...expectedConfig.metadata,
          description: '123 with additional changes',
        },
      },
      hooks: expectedHooks,
      logger: deploymentLogger,
    });
  });

  it('proceeds with provided description without warning when there are uncommited changes and the force flag is used', async () => {
    vi.mocked(ensureIsClean).mockRejectedValue(
      new GitDirectoryNotCleanError('Uncommitted changes'),
    );
    vi.mocked(getLatestGitCommit).mockResolvedValue({
      hash: '123',
      message: 'test commit',
      date: '2021-01-01',
      author_name: 'test author',
      author_email: 'test@author.com',
      body: 'test body',
      refs: 'HEAD -> main',
    });

    await runDeploy({
      ...deployParams,
      force: true,
      metadataDescription: 'cool new stuff',
    });

    expect(vi.mocked(renderWarning)).not.toHaveBeenCalled;
    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: {
        ...expectedConfig,
        environmentTag: 'main',
        metadata: {
          ...expectedConfig.metadata,
          description: 'cool new stuff',
        },
      },
      hooks: expectedHooks,
      logger: deploymentLogger,
    });
  });

  it('calls createDeploy with the checked out branch name', async () => {
    vi.mocked(getLatestGitCommit).mockResolvedValue({
      hash: '123',
      message: 'test commit',
      date: '2021-01-01',
      author_name: 'test author',
      author_email: 'test@author.com',
      body: 'test body',
      refs: 'HEAD -> main',
    });

    await runDeploy(deployParams);

    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: {...expectedConfig, environmentTag: 'main'},
      hooks: expectedHooks,
      logger: deploymentLogger,
    });
    expect(vi.mocked(renderSuccess)).toHaveBeenCalled;
  });

  it('calls renderSelectPrompt when there are multiple environments', async () => {
    vi.mocked(getOxygenDeploymentData).mockResolvedValue({
      oxygenDeploymentToken: 'some-encoded-token',
      environments: [
        {name: 'Production', branch: 'main', type: 'PRODUCTION'},
        {name: 'Preview', branch: null, type: 'PREVIEW'},
      ],
    });

    await runDeploy(deployParams);

    expect(vi.mocked(renderSelectPrompt)).toHaveBeenCalledWith({
      message: 'Select an environment to deploy to',
      choices: [
        {label: 'Production', value: 'main'},
        {label: 'Preview', value: 'shopify-preview-environment.'},
      ],
    });
  });

  describe('when Preview is selected', () => {
    it('calls createDeploy with defaultEnvironment and an undefined environmentTag', async () => {
      vi.mocked(getLatestGitCommit).mockResolvedValue({
        hash: '123',
        message: 'test commit',
        date: '2021-01-01',
        author_name: 'test author',
        author_email: 'test@author.com',
        body: 'test body',
        refs: 'HEAD -> main',
      });
      vi.mocked(getOxygenDeploymentData).mockResolvedValue({
        oxygenDeploymentToken: 'some-encoded-token',
        environments: [
          {name: 'Production', branch: 'main', type: 'PRODUCTION'},
          {name: 'Preview', branch: null, type: 'PREVIEW'},
        ],
      });

      vi.mocked(renderSelectPrompt).mockResolvedValue(
        'shopify-preview-environment.',
      );

      await runDeploy(deployParams);

      expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
        config: {
          ...expectedConfig,
          defaultEnvironment: true,
          environmentTag: undefined,
        },
        hooks: expectedHooks,
        logger: deploymentLogger,
      });
    });
  });

  it('passes the lockfileCheck to the build function when the flag is set', async () => {
    const params = {
      ...deployParams,
      lockfileCheck: false,
    };
    vi.mocked(createDeploy).mockImplementationOnce((options) => {
      options.hooks?.buildFunction?.('some-cool-asset-path');

      return new Promise((resolve, _reject) => {
        resolve({url: 'https://a-lovely-deployment.com'});
      }) as Promise<CompletedDeployment | undefined>;
    });
    await runDeploy(params);

    expect(vi.mocked(runBuild)).toHaveBeenCalledWith({
      assetPath: 'some-cool-asset-path',
      directory: params.path,
      lockfileCheck: false,
      sourcemap: true,
      useCodegen: false,
    });
  });

  it('passes a build command to createDeploy when the build-command flag is used', async () => {
    const params = {
      ...deployParams,
      buildCommand: 'hocus pocus',
    };
    const {buildFunction: _, ...hooks} = expectedHooks;

    await runDeploy(params);

    expect(vi.mocked(createDeploy)).toHaveBeenCalledWith({
      config: {
        ...expectedConfig,
        buildCommand: 'hocus pocus',
      },
      hooks: hooks,
      logger: deploymentLogger,
    });
  });

  it('writes a file with JSON content in CI environments', async () => {
    vi.mocked(ciPlatform).mockReturnValue({
      isCI: true,
      name: 'github',
      metadata: {},
    });

    const ciDeployParams = {
      ...deployParams,
      token: 'some-token',
      metadataDescription: 'cool new stuff',
      generateAuthBypassToken: true,
    };

    await runDeploy(ciDeployParams);

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      'h2_deploy_log.json',
      JSON.stringify({
        authBypassToken: 'some-token',
        url: 'https://a-lovely-deployment.com',
      }),
    );

    vi.mocked(writeFile).mockClear();
    ciDeployParams.jsonOutput = false;
    await runDeploy(ciDeployParams);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('handles error during uploadFiles', async () => {
    const mockRenderFatalError = vi.fn();
    vi.mocked(renderFatalError).mockImplementation(mockRenderFatalError);

    const error = new Error('Wonky internet!');

    vi.mocked(createDeploy).mockImplementation((options) => {
      options.hooks?.onUploadFilesStart?.();
      options.hooks?.onUploadFilesError?.(error);

      return new Promise((_resolve, reject) => {
        reject(error);
      }) as Promise<CompletedDeployment | undefined>;
    });

    try {
      await runDeploy(deployParams);
      expect(true).toBe(false);
    } catch (err) {
      if (err instanceof AbortError) {
        expect(err.message).toBe(error.message);
        expect(err.tryMessage).toBe(
          'Check your connection and try again. If the problem persists, try again later or contact support.',
        );
      } else {
        expect(true).toBe(false);
      }
    }
  });

  it('handles error during deployment routability verification', async () => {
    const mockRenderFatalError = vi.fn();
    vi.mocked(renderFatalError).mockImplementation(mockRenderFatalError);

    const error = new Error('Cloudflare is down!');

    vi.mocked(createDeploy).mockImplementation((options) => {
      options.hooks?.onUploadFilesStart?.();
      options.hooks?.onUploadFilesComplete?.();
      options.hooks?.onVerificationError?.(error);

      return new Promise((_resolve, reject) => {
        reject(error);
      }) as Promise<CompletedDeployment | undefined>;
    });

    try {
      await runDeploy(deployParams);
      expect(true).toBe(false);
    } catch (err) {
      if (err instanceof AbortError) {
        expect(err.message).toBe(error.message);
        expect(err.tryMessage).toBe(
          'Please verify the deployment status in the Shopify Admin and retry deploying if necessary.',
        );
      } else {
        expect(true).toBe(false);
      }
    }
  });

  it('handles error during deployment completion verification', async () => {
    const mockRenderFatalError = vi.fn();
    vi.mocked(renderFatalError).mockImplementation(mockRenderFatalError);

    vi.mocked(createDeploy).mockImplementation((options) => {
      options.hooks?.onUploadFilesStart?.();
      options.hooks?.onUploadFilesComplete?.();
      options.hooks?.onDeploymentCompletedVerificationStart?.();
      options.hooks?.onDeploymentFailed?.({
        status: 'oh shit',
        url: 'https://a-lovely-deployment.com',
      });

      return new Promise((_resolve, reject) => {
        reject();
      }) as Promise<CompletedDeployment | undefined>;
    });

    try {
      await runDeploy(deployParams);
      expect(true).toBe(false);
    } catch (err) {
      if (err instanceof AbortError) {
        expect(err.message).toBe('oh shit');
        expect(err.tryMessage).toBe('Retrying the deployment may succeed.');
      } else {
        expect(true).toBe(false);
      }
    }
  });

  describe('next steps', () => {
    it('renders a link to the deployment', async () => {
      vi.mocked(createDeploy).mockResolvedValue({
        url: 'https://a-lovely-deployment.com',
      });

      await runDeploy(deployParams);

      expect(vi.mocked(renderSuccess)).toHaveBeenCalledWith({
        body: ['Successfully deployed to Oxygen'],
        nextSteps: [
          [
            'Open',
            {link: {url: 'https://a-lovely-deployment.com'}},
            'in your browser to view your deployment.',
          ],
        ],
      });
    });

    it('renders a link to the deployment and shows auth bypass token when one is created', async () => {
      vi.mocked(createDeploy).mockResolvedValue({
        url: 'https://a-lovely-deployment.com',
        authBypassToken: 'some-token',
      });

      await runDeploy(deployParams);

      expect(vi.mocked(renderSuccess)).toHaveBeenCalledWith({
        body: ['Successfully deployed to Oxygen'],
        nextSteps: [
          [
            'Open',
            {link: {url: 'https://a-lovely-deployment.com'}},
            'in your browser to view your deployment.',
          ],
          [
            'Use the',
            {subdued: 'some-token'},
            'token to perform end-to-end tests against the deployment.',
          ],
        ],
      });
    });

    describe('when in a CI environment', () => {
      it('renders information about h2_deploy_log.json', async () => {
        vi.mocked(ciPlatform).mockReturnValue({
          isCI: true,
          name: 'github',
          metadata: {},
        });

        await runDeploy({...deployParams, token: 'fake-token'});

        expect(vi.mocked(renderSuccess)).toHaveBeenCalledWith({
          body: ['Successfully deployed to Oxygen'],
          nextSteps: [
            [
              'View the deployment information in',
              {subdued: 'h2_deploy_log.json'},
            ],
          ],
        });
      });

      it('renders no next steps if jsonOutput is set to false', async () => {
        vi.mocked(ciPlatform).mockReturnValue({
          isCI: true,
          name: 'github',
          metadata: {},
        });

        await runDeploy({
          ...deployParams,
          token: 'fake-token',
          jsonOutput: false,
        });

        expect(vi.mocked(renderSuccess)).toHaveBeenCalledWith({
          body: ['Successfully deployed to Oxygen'],
          nextSteps: [],
        });
      });
    });
  });
});
