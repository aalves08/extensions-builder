import { NAMESPACE, NGINX_CONFIGMAP, NGINX_PORT } from '../../config/builder';
import {
  DEFAULT_CLASS_ANNOTATION,
  LOCAL_PATH_CLASS,
  LOCAL_PATH_PROVISIONER,
  NGINX_CONF,
  localPathStorageClassObject,
  namespaceObject,
  nginxConfigMapObject,
  storageRemedy,
  storageRemedyFixable
} from '../bootstrap';

const sc = (name: string, over: { provisioner?: string; annotations?: Record<string, string> } = {}) => ({
  metadata:    { name, annotations: over.annotations || {} },
  provisioner: over.provisioner
});

describe('namespaceObject', () => {
  it('names the namespace the rest of the extension expects', () => {
    expect((namespaceObject().metadata as Record<string, unknown>).name).toBe(NAMESPACE);
  });
});

describe('nginxConfigMapObject', () => {
  const metadata = nginxConfigMapObject().metadata as Record<string, unknown>;

  it('uses the name the repo Deployment mounts', () => {
    expect(metadata.name).toBe(NGINX_CONFIGMAP);
    expect(metadata.namespace).toBe(NAMESPACE);
  });

  it('stores the config under the key the volume mount subPaths to', () => {
    expect(Object.keys(nginxConfigMapObject().data as object)).toEqual(['nginx.conf']);
  });

  it('listens on the port the Service targets', () => {
    expect(NGINX_CONF).toContain(`listen      ${ NGINX_PORT };`);
  });

  it('serves the repo root the PVC is mounted at', () => {
    expect(NGINX_CONF).toContain('root /srv/repo;');
  });

  it('keeps the healthz endpoint the readiness probe hits', () => {
    expect(NGINX_CONF).toContain('location /healthz');
  });

  it('leaves nginx variables unexpanded, rather than eating them as interpolation', () => {
    expect(NGINX_CONF).toContain('try_files $uri $uri/ /dashboard/index.html;');
  });

  it('writes a real newline escape into the healthz body, not a line break', () => {
    expect(NGINX_CONF).toContain('return 200 "ok\\n";');
  });

  it('never caches index.yaml, because a rebuild reuses the same url', () => {
    expect(NGINX_CONF).toContain('add_header Cache-Control "no-store";');
  });
});

describe('localPathStorageClassObject', () => {
  const object = localPathStorageClassObject();

  it('is marked default, which is the entire point of creating it', () => {
    const metadata = object.metadata as { annotations: Record<string, string> };

    expect(metadata.annotations[DEFAULT_CLASS_ANNOTATION]).toBe('true');
  });

  it('uses the local-path provisioner', () => {
    expect(object.provisioner).toBe(LOCAL_PATH_PROVISIONER);
    expect((object.metadata as { name: string }).name).toBe(LOCAL_PATH_CLASS);
  });

  it('binds late, so the volume lands on the node the build pod got', () => {
    expect(object.volumeBindingMode).toBe('WaitForFirstConsumer');
  });
});

describe('storageRemedy', () => {
  it('is ok when a class is already the default', () => {
    const classes = [sc('fast', { annotations: { [DEFAULT_CLASS_ANNOTATION]: 'true' } })];

    expect(storageRemedy(classes, false)).toEqual({ kind: 'ok' });
  });

  it('accepts the pre-1.6 beta annotation as a default too', () => {
    const classes = [sc('fast', { annotations: { 'storageclass.beta.kubernetes.io/is-default-class': 'true' } })];

    expect(storageRemedy(classes, false).kind).toBe('ok');
  });

  it('marks the only class as default when there is exactly one', () => {
    expect(storageRemedy([sc('local-path')], false)).toEqual({ kind: 'markDefault', target: 'local-path' });
  });

  it('creates a class when there are none and the provisioner is running', () => {
    expect(storageRemedy([], true)).toEqual({ kind: 'create' });
  });

  it('installs a provisioner rather than creating a class with nothing behind it', () => {
    // A StorageClass naming a provisioner that is not running leaves the PVC
    // Pending just the same - the exact failure we are trying to prevent.
    expect(storageRemedy([], false)).toEqual({ kind: 'install' });
  });

  it('will not guess between several non-default classes', () => {
    expect(storageRemedy([sc('fast'), sc('slow')], true)).toEqual({ kind: 'manual' });
  });

  it('breaks a tie in favour of the local-path class it would have created anyway', () => {
    const classes = [sc('fast'), sc('local-path', { provisioner: LOCAL_PATH_PROVISIONER })];

    expect(storageRemedy(classes, true)).toEqual({ kind: 'markDefault', target: 'local-path' });
  });

  it('ignores an annotation explicitly set to false', () => {
    const classes = [sc('fast', { annotations: { [DEFAULT_CLASS_ANNOTATION]: 'false' } })];

    expect(storageRemedy(classes, false)).toEqual({ kind: 'markDefault', target: 'fast' });
  });

  it('skips a class with no name rather than producing an unusable target', () => {
    expect(storageRemedy([{ metadata: {} }, sc('fast')], false)).toEqual({ kind: 'markDefault', target: 'fast' });
  });

  it.each([[null], [undefined]])('treats %s as no classes at all', (input) => {
    expect(storageRemedy(input as null, true)).toEqual({ kind: 'create' });
  });
});

describe('storageRemedyFixable', () => {
  it.each([
    ['markDefault', true],
    ['create', true],
    ['install', true],
    ['manual', false],
    ['ok', false]
  ])('%s -> %s', (kind, expected) => {
    expect(storageRemedyFixable({ kind } as { kind: 'ok' })).toBe(expected);
  });
});
