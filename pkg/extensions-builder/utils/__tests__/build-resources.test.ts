import {
  BUILDER_IMAGE, BUILD_DEADLINE_SECONDS, LABEL_BUILD_ID, NGINX_PORT, buildName, repoName
} from '../../config/builder';
import { ExtensionSource, ShellSource } from '../../types';
import {
  buildObjectsFor,
  buildSpecFor,
  clusterRepoFor,
  configMapFor,
  dashboardPublicUrl,
  deploymentFor,
  generateBuildId,
  ingressFor,
  jobFor,
  publishObjectsFor,
  pvcFor,
  sanitizeForName,
  serviceFor,
  specWithRepo
} from '../build-resources';

const SHELL: ShellSource = {
  repo: 'https://github.com/rancher/dashboard.git', pr: 13579, ref: null
};

const EXTENSION: ExtensionSource = {
  name: 'kubewarden', repo: 'https://github.com/rancher/kubewarden-ui.git', ref: '', pkg: 'kubewarden', official: true
};

/** Whatever Kubernetes happens to allocate; the tests only care that it is used. */
const CLUSTER_IP = '10.43.1.74';

const draftFor = (over: Partial<Parameters<typeof buildSpecFor>[0]> = {}) => buildSpecFor({
  id:             'pr13579-abcd',
  shell:          SHELL,
  extensions:     [EXTENSION],
  buildDashboard: false,
  ...over
});

const specFor = (over: Partial<Parameters<typeof buildSpecFor>[0]> = {}) => specWithRepo(draftFor(over), CLUSTER_IP);

/* eslint-disable @typescript-eslint/no-explicit-any */
const asAny = (value: unknown): any => value;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('sanitizeForName', () => {
  it.each([
    ['release/v2.9', 'release-v2-9'],
    ['Feature_Branch', 'feature-branch'],
    ['--leading-and-trailing--', 'leading-and-trailing'],
    ['a//b', 'a-b']
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeForName(input)).toBe(expected);
  });

  it.each([[''], ['///'], ['---']])('falls back to "build" for %s', (input) => {
    expect(sanitizeForName(input)).toBe('build');
  });
});

describe('generateBuildId', () => {
  it('prefixes with the PR number so the list reads at a glance', () => {
    expect(generateBuildId(SHELL, () => 0.5)).toMatch(/^pr13579-/);
  });

  it('prefixes with a sanitised ref when there is no PR', () => {
    const id = generateBuildId({
      repo: 'r', pr: null, ref: 'release/v2.9'
    }, () => 0.5);

    expect(id).toMatch(/^release-v2-9-/);
  });

  it('adds a suffix, so re-running the same PR does not collide with the build still serving', () => {
    const first = generateBuildId(SHELL, () => 0.1);
    const second = generateBuildId(SHELL, () => 0.9);

    expect(first).not.toBe(second);
  });

  it('keeps the repo Service name inside the 63 character DNS limit', () => {
    const longRef = 'a'.repeat(200);
    const id = generateBuildId({
      repo: 'r', pr: null, ref: longRef
    }, () => 0.5);

    expect(repoName(id).length).toBeLessThanOrEqual(63);
  });
});

describe('buildSpecFor', () => {
  it('leaves the repo out, because the Service has no IP yet when the form is submitted', () => {
    expect(draftFor()).not.toHaveProperty('repo');
  });

  it('omits the dashboard block when the toggle is off', () => {
    expect(draftFor().dashboard).toBeUndefined();
  });

  it('adds the dashboard block, trimming a trailing slash off the public url', () => {
    const spec = draftFor({ buildDashboard: true, dashboardPublicUrl: 'https://builder.example.com/dashboard/' });

    expect(spec.dashboard).toEqual({ publicUrl: 'https://builder.example.com/dashboard', routerBase: '/dashboard' });
  });
});

describe('specWithRepo', () => {
  // An IP, not a Service DNS name: Rancher fetches both the ClusterRepo index
  // and the UIPlugin endpoint itself, and a Rancher running outside the cluster
  // - which is how every local dev setup runs it - cannot resolve cluster DNS.
  it('bakes in the repo URL as an IP, which the packaging phase writes into every chart', () => {
    expect(specFor().repo.serviceUrl).toBe(`http://${ CLUSTER_IP }:${ NGINX_PORT }`);
  });

  it('leaves the rest of the draft untouched', () => {
    expect(specWithRepo(draftFor(), CLUSTER_IP)).toMatchObject(draftFor());
  });
});

describe('configMapFor', () => {
  it('stores the spec both as data for the Job and as an annotation for the list', () => {
    const spec = specFor();
    const configMap = asAny(configMapFor(spec));
    const fromData = JSON.parse(configMap.data['build.json']);

    expect(fromData).toEqual(spec);
    expect(JSON.parse(configMap.metadata.annotations['extensions-builder.cattle.io/spec'])).toEqual(spec);
  });

  it('is labelled with the build id so it can be found and cleaned up', () => {
    expect(asAny(configMapFor(specFor())).metadata.labels[LABEL_BUILD_ID]).toBe('pr13579-abcd');
  });
});

describe('pvcFor', () => {
  it('asks for ReadWriteOnce, which is all a default StorageClass is guaranteed to offer', () => {
    expect(asAny(pvcFor('pr13579-abcd')).spec.accessModes).toEqual(['ReadWriteOnce']);
  });

  it('shares a name with the Job, which is what the Job mounts', () => {
    expect(asAny(pvcFor('pr13579-abcd')).metadata.name).toBe(buildName('pr13579-abcd'));
  });
});

describe('jobFor', () => {
  const job = asAny(jobFor(specFor()));
  const podSpec = job.spec.template.spec;
  const container = podSpec.containers[0];

  it('never retries, because a retry would fail the same way 30 minutes later', () => {
    expect(job.spec.backoffLimit).toBe(0);
  });

  it('has a deadline, so a wedged build does not hold a node forever', () => {
    expect(job.spec.activeDeadlineSeconds).toBe(BUILD_DEADLINE_SECONDS);
  });

  it('is not given a service account token - the build talks to no Kubernetes API', () => {
    expect(podSpec.automountServiceAccountToken).toBe(false);
  });

  it('runs the builder image and never restarts the pod', () => {
    expect(container.image).toBe(BUILDER_IMAGE);
    expect(podSpec.restartPolicy).toBe('Never');
  });

  it('mounts the config read-only, the output PVC writable, and scratch as emptyDir', () => {
    const mounts = Object.fromEntries(container.volumeMounts.map((m: { name: string }) => [m.name, m]));

    expect(mounts.config).toMatchObject({ mountPath: '/config', readOnly: true });
    expect(mounts.repo.mountPath).toBe('/srv/repo');
    expect(mounts.work.mountPath).toBe('/work');

    const volumes = Object.fromEntries(podSpec.volumes.map((v: { name: string }) => [v.name, v]));

    expect(volumes.config.configMap.name).toBe(buildName('pr13579-abcd'));
    expect(volumes.repo.persistentVolumeClaim.claimName).toBe(buildName('pr13579-abcd'));
    expect(volumes.work.emptyDir).toBeDefined();
    expect(volumes.work.persistentVolumeClaim).toBeUndefined();
  });

  it('names the container "build", which is what the log fetch and log window ask for', () => {
    expect(container.name).toBe('build');
  });

  it('is left with no ttlSecondsAfterFinished, so a failed build keeps its log', () => {
    expect(job.spec.ttlSecondsAfterFinished).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('ttlSecondsAfterFinished');
  });
});

describe('buildObjectsFor', () => {
  it('produces all three objects under one name', () => {
    const objects = buildObjectsFor(specFor());
    const name = buildName('pr13579-abcd');

    expect(asAny(objects.configMap).metadata.name).toBe(name);
    expect(asAny(objects.pvc).metadata.name).toBe(name);
    expect(asAny(objects.job).metadata.name).toBe(name);
  });
});

describe('deploymentFor', () => {
  const deployment = asAny(deploymentFor('pr13579-abcd'));

  it('recreates rather than rolls, because the output PVC is ReadWriteOnce', () => {
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  it('mounts the build output read-only', () => {
    const mount = deployment.spec.template.spec.containers[0].volumeMounts
      .find((m: { name: string }) => m.name === 'repo');

    expect(mount).toMatchObject({ mountPath: '/srv/repo', readOnly: true });
  });

  it('runs as a non-root user, with /tmp writable so nginx can start', () => {
    const podSpec = deployment.spec.template.spec;

    expect(podSpec.securityContext.runAsNonRoot).toBe(true);
    expect(podSpec.volumes.some((v: { name: string }) => v.name === 'tmp')).toBe(true);
  });

  it('selects exactly the labels it sets on the pod', () => {
    expect(deployment.spec.selector.matchLabels).toEqual(deployment.spec.template.metadata.labels);
  });
});

describe('serviceFor', () => {
  it('selects the repo pods and exposes the nginx port', () => {
    const service = asAny(serviceFor('pr13579-abcd'));

    expect(service.spec.selector[LABEL_BUILD_ID]).toBe('pr13579-abcd');
    expect(service.spec.ports[0]).toMatchObject({ port: NGINX_PORT, targetPort: NGINX_PORT });
  });
});

describe('clusterRepoFor', () => {
  const serviceUrl = `http://${ CLUSTER_IP }:${ NGINX_PORT }`;
  const repo = asAny(clusterRepoFor('pr13579-abcd', serviceUrl));

  it('is cluster scoped - no namespace', () => {
    expect(repo.metadata.namespace).toBeUndefined();
  });

  it('ends the url with a slash, because index.yaml is resolved against it', () => {
    expect(repo.spec.url).toBe(`${ serviceUrl }/`);
  });

  it('does not double the slash if the url it was given already had one', () => {
    expect(asAny(clusterRepoFor('pr13579-abcd', `${ serviceUrl }/`)).spec.url).toBe(`${ serviceUrl }/`);
  });

  // The charts this repo serves carry the packaged URL in plugin.endpoint. If
  // the repo were to derive its own, the two could disagree and the extension
  // would install from one place and load from another.
  it('uses the url it is given rather than deriving one', () => {
    expect(asAny(clusterRepoFor('pr13579-abcd', 'http://10.43.9.9:8080')).spec.url).toBe('http://10.43.9.9:8080/');
  });
});

describe('ingressFor', () => {
  it('routes only /dashboard, which is the one thing the browser fetches directly', () => {
    const ingress = asAny(ingressFor('pr13579-abcd', 'builder.example.com'));
    const path = ingress.spec.rules[0].http.paths[0];

    expect(ingress.spec.rules[0].host).toBe('builder.example.com');
    expect(path).toMatchObject({ path: '/dashboard', pathType: 'Prefix' });
    expect(path.backend.service.name).toBe(repoName('pr13579-abcd'));
  });

  it('has no tls block unless a secret was given', () => {
    expect(asAny(ingressFor('pr13579-abcd', 'builder.example.com')).spec.tls).toBeUndefined();
  });

  it('adds tls for the same host when a secret is given', () => {
    const ingress = asAny(ingressFor('pr13579-abcd', 'builder.example.com', 'builder-tls'));

    expect(ingress.spec.tls).toEqual([{ hosts: ['builder.example.com'], secretName: 'builder-tls' }]);
  });
});

describe('publishObjectsFor', () => {
  const serviceUrl = `http://${ CLUSTER_IP }:${ NGINX_PORT }`;

  it('leaves out the Ingress when no dashboard host is given', () => {
    expect(publishObjectsFor('pr13579-abcd', serviceUrl).ingress).toBeUndefined();
  });

  it('includes the Ingress when one is', () => {
    expect(publishObjectsFor('pr13579-abcd', serviceUrl, { host: 'builder.example.com' }).ingress).toBeDefined();
  });

  // It is created with the build instead, so the packaging phase can bake its
  // ClusterIP into the charts.
  it('does not create the Service', () => {
    expect(publishObjectsFor('pr13579-abcd', serviceUrl)).not.toHaveProperty('service');
  });
});

describe('dashboardPublicUrl', () => {
  it.each([
    ['builder.example.com', true, 'https://builder.example.com/dashboard'],
    ['builder.example.com', false, 'http://builder.example.com/dashboard'],
    ['  builder.example.com/  ', true, 'https://builder.example.com/dashboard']
  ])('%s (tls: %s) -> %s', (host, tls, expected) => {
    expect(dashboardPublicUrl(host, tls)).toBe(expected);
  });
});
