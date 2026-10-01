<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import { Card } from '@components/Card';
import AppModal from '@shell/components/AppModal.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import Loading from '@shell/components/Loading.vue';
import SortableTable from '@shell/components/SortableTable/index.vue';
import { LABEL_BUILD_ID, ROUTE_BUILDS, ROUTE_NEW_BUILD } from '../config/builder';
import { BuildState, BuildSpec } from '../types';
import { deleteBuild, listClusterRepos, listConfigMaps, listJobs } from '../utils/api';
import { jobBuildState, specFromAnnotations, shellSourceLabel } from '../utils/build-state';
import rawTranslations from '../utils/i18n';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface BuildRow {
  id: string;
  state: BuildState;
  shell: string;
  extensions: string;
  createdAt: string;
  published: boolean;
  spec: BuildSpec | null;
}

const POLL_MS = 10000;

/**
 * The landing page: every build that exists, in whatever state.
 *
 * A build is a Job plus a ConfigMap plus a PVC, and optionally a Deployment,
 * Service and ClusterRepo. The Job is the thing that always exists, so it is
 * what the list is built from; the ConfigMap carries the spec as an annotation
 * so a row can say what it was building without a second round trip per build.
 */
export default defineComponent({
  name: 'BuildList',

  mixins: [rawTranslations],

  components: {
    AppModal, AsyncButton, Banner, Card, Loading, SortableTable
  },

  data() {
    return {
      loading:      true,
      loadError:    null as string | null,
      rows:         [] as BuildRow[],
      pollHandle:   null as ReturnType<typeof setInterval> | null,
      confirmingId: null as string | null
    };
  },

  computed: {
    headers() {
      return [
        {
          name: 'state', label: this.t('extensionsBuilder.list.headers.state'), value: 'state', sort: 'state', width: 110
        },
        {
          name: 'id', label: this.t('extensionsBuilder.list.headers.id'), value: 'id', sort: 'id'
        },
        {
          name: 'shell', label: this.t('extensionsBuilder.list.headers.shell'), value: 'shell', sort: 'shell', width: 120
        },
        {
          name: 'extensions', label: this.t('extensionsBuilder.list.headers.extensions'), value: 'extensions', sort: 'extensions'
        },
        {
          name: 'published', label: this.t('extensionsBuilder.list.headers.published'), value: 'published', sort: 'published', width: 110
        },
        {
          name: 'createdAt', label: this.t('extensionsBuilder.list.headers.created'), value: 'createdAt', sort: 'createdAt:desc', formatter: 'LiveDate', width: 120
        },
        {
          name: 'actions', label: ' ', value: 'id', sort: false, width: 180
        }
      ];
    },

    newBuildLocation() {
      return { name: ROUTE_NEW_BUILD };
    },

    confirmingRow(): BuildRow | null {
      return this.rows.find((row) => row.id === this.confirmingId) || null;
    }
  },

  async mounted() {
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_MS);
  },

  beforeUnmount() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }
  },

  methods: {
    async load(quiet = false) {
      if (!quiet) {
        this.loading = true;
      }

      try {
        const [jobs, configMaps, repos] = await Promise.all([
          listJobs(this.$store),
          listConfigMaps(this.$store),
          listClusterRepos(this.$store)
        ]);

        const specById: Record<string, BuildSpec | null> = {};

        configMaps.forEach((cm: SteveResource) => {
          const id = cm.metadata?.labels?.[LABEL_BUILD_ID];

          if (id) {
            specById[id] = specFromAnnotations(cm.metadata?.annotations);
          }
        });

        const publishedIds = new Set(
          repos.map((repo: SteveResource) => repo.metadata?.labels?.[LABEL_BUILD_ID]).filter(Boolean)
        );

        this.rows = jobs
          .map((job: SteveResource): BuildRow | null => {
            const id = job.metadata?.labels?.[LABEL_BUILD_ID];

            if (!id) {
              return null;
            }

            const spec = specById[id] || null;

            return {
              id,
              state:      jobBuildState(job.status),
              shell:      shellSourceLabel(spec),
              extensions: (spec?.extensions || []).map((ext) => ext.name).join(', ') || '-',
              createdAt:  job.metadata?.creationTimestamp || '',
              published:  publishedIds.has(id),
              spec
            };
          })
          .filter((row): row is BuildRow => !!row);

        this.loadError = null;
      } catch (e) {
        this.loadError = (e as Error).message;
      } finally {
        this.loading = false;
      }
    },

    buildLocation(id: string) {
      return { name: ROUTE_BUILDS, query: { id } };
    },

    stateColor(state: BuildState): string {
      switch (state) {
      case 'success': return 'bg-success';
      case 'failed': return 'bg-error';
      case 'running': return 'bg-info';
      default: return 'bg-darker';
      }
    },

    confirmDelete(id: string) {
      this.confirmingId = id;
    },

    async doDelete(done: (ok: boolean) => void) {
      const id = this.confirmingId;

      if (!id) {
        done(false);

        return;
      }

      try {
        await deleteBuild(this.$store, id);
        this.confirmingId = null;
        await this.load(true);
        done(true);
      } catch (e) {
        this.$store.dispatch('growl/fromError', { title: this.t('extensionsBuilder.list.deleteFailed'), err: e });
        done(false);
      }
    },

    /** Re-run means "same spec, new build": a new id, so the old one keeps serving. */
    rerun(row: BuildRow) {
      if (!row.spec) {
        return;
      }

      this.$router.push({
        name:  ROUTE_NEW_BUILD,
        query: { from: row.id }
      });
    }
  }
});
</script>

<template>
  <div class="builds-list">
    <div class="masthead">
      <h1>{{ t('extensionsBuilder.list.title') }}</h1>
      <router-link
        :to="newBuildLocation"
        class="btn role-primary"
      >
        {{ t('extensionsBuilder.list.newBuild') }}
      </router-link>
    </div>

    <p class="intro text-muted">
      {{ t('extensionsBuilder.list.intro') }}
    </p>

    <Banner
      v-if="loadError"
      color="error"
      role="alert"
      :label="loadError"
    />

    <Loading v-if="loading" />

    <Banner
      v-else-if="!rows.length"
      color="info"
      :label="t('extensionsBuilder.list.empty')"
    />

    <SortableTable
      v-else
      key-field="id"
      :headers="headers"
      :rows="rows"
      :table-actions="false"
      :row-actions="false"
      default-sort-by="createdAt"
    >
      <template #col:state="{ row }">
        <td>
          <span
            class="badge-state"
            :class="stateColor(row.state)"
          >{{ t(`extensionsBuilder.state.${ row.state }`) }}</span>
        </td>
      </template>

      <template #col:id="{ row }">
        <td>
          <router-link :to="buildLocation(row.id)">
            {{ row.id }}
          </router-link>
        </td>
      </template>

      <template #col:published="{ row }">
        <td>
          <i
            v-if="row.published"
            v-clean-tooltip="t('extensionsBuilder.list.publishedYes')"
            class="icon icon-checkmark text-success"
          />
          <span
            v-else
            class="text-muted"
          >&ndash;</span>
        </td>
      </template>

      <template #col:actions="{ row }">
        <td class="actions-cell">
          <button
            type="button"
            class="btn btn-sm role-secondary"
            :disabled="!row.spec"
            @click="rerun(row)"
          >
            {{ t('extensionsBuilder.list.rerun') }}
          </button>
          <button
            type="button"
            class="btn btn-sm role-link text-error"
            @click="confirmDelete(row.id)"
          >
            {{ t('generic.remove') }}
          </button>
        </td>
      </template>
    </SortableTable>

    <AppModal
      v-if="confirmingRow"
      name="confirm-delete-build"
      :width="500"
      @close="confirmingId = null"
    >
      <Card :show-highlight-border="false">
        <template #title>
          <h4 class="text-default-text">
            {{ t('extensionsBuilder.list.deleteTitle', { id: confirmingRow.id }) }}
          </h4>
        </template>
        <template #body>
          <p>{{ t('extensionsBuilder.list.deleteBody') }}</p>
        </template>
        <template #actions>
          <button
            type="button"
            class="btn role-secondary"
            @click="confirmingId = null"
          >
            {{ t('generic.cancel') }}
          </button>
          <AsyncButton
            mode="delete"
            action-color="role-primary bg-error"
            @click="doDelete"
          />
        </template>
      </Card>
    </AppModal>
  </div>
</template>

<style lang="scss" scoped>
.masthead {
  align-items: center;
  display: flex;
  justify-content: space-between;

  h1 {
    margin: 0;
  }
}

.intro {
  margin: 8px 0 20px 0;
  max-width: 70ch;
}

.actions-cell {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
