<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton.vue';
import Loading from '@shell/components/Loading.vue';
import CopyToClipboard from '@shell/components/CopyToClipboard.vue';
import HostUiCard from './HostUiCard.vue';
import PhaseStepper from './PhaseStepper.vue';
import { NAMESPACE, ROUTE_BUILDS, buildName } from '../config/builder';
import { BuildPhase, BuildSpec, BuildState } from '../types';
import { STEVE_TYPES } from '../utils/build-resources';
import {
  fetchBuildLog, findBuildPod, findOrNull, isPublished, openLogWindow, publishBuild, syncClusterRepo
} from '../utils/api';
import { formatDuration, parseBuildLog, reconcilePhases } from '../utils/build-log';
import {
  BlockedReason, isFinished, jobBuildState, jobFailureReason, podBlockedReason, specFromAnnotations, shellSourceLabel
} from '../utils/build-state';
import {
  ExpectedChart, VerifyResult, expectedCharts, verifyIndex, verifyMessage
} from '../utils/verify-repo';
import rawTranslations from '../utils/i18n';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Fast enough that the stepper feels live, slow enough not to hammer Steve. */
const POLL_RUNNING_MS = 5000;
/** Once it is over, nothing changes except whether it has been published. */
const POLL_IDLE_MS = 30000;

/**
 * One build, end to end.
 *
 * A build takes 20-40 minutes, so this page has to be something you can come
 * back to: everything it shows is derived from cluster state and the pod log,
 * nothing is held in memory from the submit, and closing the tab costs nothing.
 */
export default defineComponent({
  name: 'BuildDetail',

  mixins: [rawTranslations],

  components: {
    AsyncButton, Banner, CopyToClipboard, HostUiCard, Loading, PhaseStepper
  },

  props: {
    buildId: {
      type:     String,
      required: true
    }
  },

  data() {
    return {
      loading:        true,
      loadError:      null as string | null,
      spec:           null as BuildSpec | null,
      job:            null as SteveResource | null,
      pod:            null as SteveResource | null,
      state:          'pending' as BuildState,
      phases:         [] as BuildPhase[],
      shellSha:       null as string | null,
      shellRef:       null as string | null,
      packages:       [] as ExpectedChart[],
      dashboardIndex: null as string | null,
      lastLine:       null as string | null,
      published:      false,
      verify:         null as VerifyResult | null,
      publishError:   null as string | null,
      pollHandle:     null as ReturnType<typeof setTimeout> | null,
      now:            Date.now()
    };
  },

  computed: {
    finished(): boolean {
      return isFinished(this.state);
    },

    failureReason(): string | null {
      return jobFailureReason(this.job?.status);
    },

    /**
     * Set when the pod is up but its container will never start - a bad image,
     * or a node that cannot take it. The Job stays active and the phases stay
     * on Waiting, so without this the page just sits there saying nothing.
     */
    blocked(): BlockedReason | null {
      return podBlockedReason(this.pod?.status);
    },

    shellLabel(): string {
      return shellSourceLabel(this.spec);
    },

    /**
     * How long the build has been going, or took.
     *
     * Measured from the Job's own startTime rather than by summing the phases,
     * so it includes everything the phases cannot see - scheduling, pulling the
     * builder image, waiting on the volume. That gap is often where a build
     * that "takes forever" actually went.
     */
    elapsed(): string {
      const start = this.job?.status?.startTime;

      if (!start) {
        return '';
      }

      const startedAt = Date.parse(start);

      if (!Number.isFinite(startedAt)) {
        return '';
      }

      const completion = this.job?.status?.completionTime;
      const endedAt = completion ? Date.parse(completion) : this.now;

      return formatDuration((endedAt - startedAt) / 1000);
    },

    canPublish(): boolean {
      return this.state === 'success' && !this.published;
    },

    extensionsRoute() {
      return { name: 'c-cluster-uiplugins', params: { cluster: 'local' } };
    },

    verifyBanner(): { color: string; label: string } | null {
      if (!this.verify) {
        return null;
      }

      const { key, args } = verifyMessage(this.verify);

      return {
        color: this.verify.ok ? 'success' : 'warning',
        label: this.t(key, args)
      };
    },

    /**
     * Where another Rancher can reach this build's repository, or '' when the
     * build was not set up for it.
     *
     * Read off the spec rather than worked out here. It was fixed before the
     * build started - it is already inside every chart this repository serves -
     * so the only honest source for it is the spec the build ran with.
     */
    externalUrl(): string {
      return this.spec?.repo?.publicUrl || '';
    },

    /** The repository URL as Rancher's "Add repository" form wants it. */
    externalIndexUrl(): string {
      return this.externalUrl ? `${ this.externalUrl }/` : '';
    },

    backLocation() {
      return { name: ROUTE_BUILDS };
    }
  },

  watch: {
    buildId() {
      this.restart();
    }
  },

  async mounted() {
    await this.restart();
  },

  beforeUnmount() {
    this.stopPolling();
  },

  methods: {
    stopPolling() {
      if (this.pollHandle) {
        clearTimeout(this.pollHandle);
        this.pollHandle = null;
      }
    },

    async restart() {
      this.stopPolling();
      this.loading = true;
      this.verify = null;
      this.publishError = null;
      await this.load();
      this.schedule();
    },

    /**
     * A self-rescheduling timeout rather than setInterval: a slow log fetch must
     * not stack up a queue of overlapping polls behind it.
     */
    schedule() {
      this.stopPolling();
      this.pollHandle = setTimeout(async() => {
        await this.load();
        this.schedule();
      }, this.finished ? POLL_IDLE_MS : POLL_RUNNING_MS);
    },

    async load() {
      try {
        const name = buildName(this.buildId);

        const [job, configMap, pod, published] = await Promise.all([
          findOrNull(this.$store, STEVE_TYPES.JOB, `${ NAMESPACE }/${ name }`),
          findOrNull(this.$store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ name }`),
          findBuildPod(this.$store, this.buildId),
          isPublished(this.$store, this.buildId)
        ]);

        this.job = job;
        this.pod = pod;
        this.published = published;
        this.spec = specFromAnnotations(configMap?.metadata?.annotations);
        this.state = jobBuildState(job?.status);

        // No pod yet means the Job has not been scheduled - usually a missing
        // StorageClass or a node without room. There is no log to read.
        const log = pod ? await fetchBuildLog(this.$store, pod) : '';
        const parsed = parseBuildLog(log);

        this.phases = reconcilePhases(parsed.phases, this.finished, this.state === 'failed');
        this.shellSha = parsed.shellSha;
        this.shellRef = parsed.shellRef;
        this.packages = expectedCharts(parsed.packages);
        this.dashboardIndex = parsed.dashboardIndex;
        this.lastLine = parsed.lastLine;
        this.loadError = null;
        // Drives the live elapsed clock. Updated here rather than on its own
        // timer so the number never disagrees with the phases beside it.
        this.now = Date.now();
      } catch (e) {
        this.loadError = (e as Error).message;
      } finally {
        this.loading = false;
      }
    },

    viewLog() {
      if (this.pod) {
        openLogWindow(this.$store, this.pod);
      }
    },

    /**
     * Stand the repo up, wait for Rancher to sync it, then check the index
     * actually contains the charts this build produced. An empty index syncs
     * to `active` perfectly happily, which is the failure worth catching.
     */
    async publish(done: (ok: boolean) => void) {
      this.publishError = null;
      this.verify = null;

      try {
        if (!this.published) {
          await publishBuild(this.$store, this.buildId);
          this.published = true;
        }

        const index = await syncClusterRepo(this.$store, this.buildId);

        this.verify = verifyIndex(index, this.packages);
        done(this.verify.ok);
      } catch (e) {
        this.publishError = (e as Error).message;
        done(false);
      }
    }
  }
});
</script>

<template>
  <div class="build-detail">
    <div class="masthead">
      <div>
        <router-link :to="backLocation">
          &larr; {{ t('extensionsBuilder.detail.back') }}
        </router-link>
        <h1>{{ buildId }}</h1>
      </div>
      <div class="masthead-actions">
        <button
          type="button"
          class="btn role-secondary"
          :disabled="!pod"
          @click="viewLog"
        >
          {{ t('extensionsBuilder.detail.viewLog') }}
        </button>
      </div>
    </div>

    <Banner
      v-if="loadError"
      color="error"
      role="alert"
      :label="loadError"
    />

    <Loading v-if="loading" />

    <Banner
      v-else-if="!job"
      color="warning"
      :label="t('extensionsBuilder.detail.notFound')"
    />

    <template v-else>
      <Banner
        v-if="state === 'failed'"
        color="error"
        role="alert"
        :label="failureReason || t('extensionsBuilder.detail.failed')"
      />
      <Banner
        v-else-if="blocked"
        color="error"
        role="alert"
      >
        <div>
          <p>{{ t('extensionsBuilder.detail.podBlocked', { reason: blocked.reason }) }}</p>
          <p
            v-if="blocked.message"
            class="blocked-detail"
          >
            {{ blocked.message }}
          </p>
        </div>
      </Banner>
      <Banner
        v-else-if="state === 'pending' && !pod"
        color="info"
        :label="t('extensionsBuilder.detail.noPod')"
      />

      <div class="columns">
        <section class="panel">
          <h3>{{ t('extensionsBuilder.detail.progress') }}</h3>
          <PhaseStepper :phases="phases" />
          <p
            v-if="lastLine && !finished"
            class="last-line text-muted"
          >
            {{ lastLine }}
          </p>
        </section>

        <section class="panel">
          <h3>{{ t('extensionsBuilder.detail.summary') }}</h3>
          <dl class="summary">
            <dt>{{ t('extensionsBuilder.detail.shell') }}</dt>
            <dd>{{ shellLabel }}</dd>

            <dt>{{ t('extensionsBuilder.detail.shellSha') }}</dt>
            <dd>
              <template v-if="shellSha">
                <code>{{ shellSha.slice(0, 12) }}</code>
                <CopyToClipboard
                  :text="shellSha"
                  :show-label="false"
                  action-color="role-link"
                />
              </template>
              <span
                v-else
                class="text-muted"
              >&ndash;</span>
            </dd>

            <dt>{{ t('extensionsBuilder.detail.shellRef') }}</dt>
            <dd>{{ shellRef || '-' }}</dd>

            <dt>{{ t('extensionsBuilder.detail.elapsed') }}</dt>
            <dd>
              <span v-if="elapsed">{{ elapsed }}</span>
              <span
                v-else
                class="text-muted"
              >&ndash;</span>
            </dd>

            <dt>{{ t('extensionsBuilder.detail.packages') }}</dt>
            <dd>
              <ul
                v-if="packages.length"
                class="packages"
              >
                <li
                  v-for="pkg in packages"
                  :key="pkg.name"
                >
                  {{ pkg.name }} <span class="text-muted">{{ pkg.version }}</span>
                </li>
              </ul>
              <span
                v-else
                class="text-muted"
              >&ndash;</span>
            </dd>
          </dl>
        </section>
      </div>

      <section class="panel">
        <h3>{{ t('extensionsBuilder.detail.publish.title') }}</h3>
        <p class="text-muted">
          {{ t('extensionsBuilder.detail.publish.description') }}
        </p>

        <Banner
          v-if="!finished"
          color="info"
          :label="t('extensionsBuilder.detail.publish.waiting')"
        />
        <Banner
          v-else-if="state === 'failed'"
          color="info"
          :label="t('extensionsBuilder.detail.publish.buildFailed')"
        />

        <template v-else>
          <Banner
            v-if="publishError"
            color="error"
            role="alert"
            :label="publishError"
          />
          <Banner
            v-if="verifyBanner"
            :color="verifyBanner.color"
            :label="verifyBanner.label"
          />

          <div class="actions">
            <AsyncButton
              mode="apply"
              :action-label="canPublish ? t('extensionsBuilder.detail.publish.action') : t('extensionsBuilder.detail.publish.resync')"
              @click="publish"
            />
            <router-link
              v-if="published"
              :to="extensionsRoute"
              class="btn role-secondary"
            >
              {{ t('extensionsBuilder.detail.publish.goToExtensions') }}
            </router-link>
          </div>
        </template>
      </section>

      <section
        v-if="finished && state !== 'failed'"
        class="panel"
      >
        <h3>{{ t('extensionsBuilder.detail.external.title') }}</h3>
        <p class="text-muted mb-20">
          {{ t('extensionsBuilder.detail.external.description') }}
        </p>

        <p
          v-if="!externalUrl"
          class="text-muted"
        >
          {{ t('extensionsBuilder.detail.external.none') }}
        </p>

        <template v-else>
          <div class="external-url">
            <code>{{ externalIndexUrl }}</code>
            <CopyToClipboard
              :text="externalIndexUrl"
              :show-label="false"
              action-color="role-link"
            />
          </div>

          <Banner
            v-if="!published"
            color="info"
            :label="t('extensionsBuilder.detail.external.notPublished')"
          />

          <h4>{{ t('extensionsBuilder.detail.external.stepsTitle') }}</h4>
          <ol class="steps">
            <li>{{ t('extensionsBuilder.detail.external.step1') }}</li>
            <li>{{ t('extensionsBuilder.detail.external.step2') }}</li>
            <li>{{ t('extensionsBuilder.detail.external.step3') }}</li>
            <li>{{ t('extensionsBuilder.detail.external.step4') }}</li>
          </ol>

          <p class="text-muted hint">
            {{ t('extensionsBuilder.detail.external.caveat') }}
          </p>
        </template>
      </section>

      <HostUiCard
        v-if="spec && spec.buildDashboard"
        :build-id="buildId"
        :index-url="dashboardIndex || ''"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.masthead {
  align-items: flex-start;
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;

  h1 {
    margin: 4px 0 0 0;
  }
}

.columns {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr 1fr;

  @media screen and (max-width: 920px) {
    grid-template-columns: 1fr;
  }
}

.panel {
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  margin-bottom: 16px;
  padding: 16px;

  h3 {
    margin-top: 0;
  }
}

.summary {
  display: grid;
  gap: 4px 16px;
  grid-template-columns: max-content 1fr;
  margin: 0;

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }
}

.packages {
  list-style: none;
  margin: 0;
  padding: 0;
}

.last-line {
  font-family: monospace;
  font-size: 12px;
  margin: 12px 0 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.external-url {
  align-items: center;
  display: flex;
  gap: 8px;
  margin: 12px 0;

  code {
    overflow-x: auto;
    white-space: nowrap;
  }
}

.steps {
  margin: 0;
  padding-left: 20px;

  li {
    margin-bottom: 4px;
  }
}

.hint {
  font-size: 12px;
  margin: 12px 0 0 0;
}

// Kubernetes' own words, verbatim. Monospace so an image reference in it is
// readable, and not wrapped mid-tag.
.blocked-detail {
  font-family: monospace;
  font-size: 12px;
  margin: 8px 0 0 0;
  word-break: break-word;
}
</style>
