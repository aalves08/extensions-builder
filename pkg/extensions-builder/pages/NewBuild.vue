<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import AsyncButton from '@shell/components/AsyncButton.vue';
import Loading from '@shell/components/Loading.vue';
import { isAdminUser } from '@shell/store/type-map';
import ExtensionPicker from '../components/ExtensionPicker.vue';
import PreflightBanners from '../components/PreflightBanners.vue';
import ShellSourceForm from '../components/ShellSourceForm.vue';
import { DASHBOARD_REPO, NAMESPACE, ROUTE_BUILDS, buildName } from '../config/builder';
import { ExtensionSource, PickerRow, PreflightResult, ShellSource } from '../types';
import {
  createBuild,
  ensureDefaultStorageClass,
  ensureNamespace,
  ensureNginxConfig,
  findOrNull,
  listStorageClasses,
  localPathProvisionerPresent,
  namespaceExists,
  nginxConfigExists,
  schemaFor
} from '../utils/api';
import { STEVE_TYPES, buildSpecFor, dashboardPublicUrl, generateBuildId } from '../utils/build-resources';
import { storageRemedy } from '../utils/bootstrap';
import { ClusterOption, clusterOptions } from '../utils/clusters';
import { LOCAL_CLUSTER } from '../utils/steve-proxy';
import { countDefaultStorageClasses, preflightBlocked, runPreflight } from '../utils/preflight';
import { specFromAnnotations } from '../utils/build-state';
import rawTranslations from '../utils/i18n';

/**
 * The new build form.
 *
 * Everything expensive about this feature happens after submit and takes half
 * an hour, so the form does as much checking as it can beforehand: the shell
 * source is resolved against GitHub live, the extension rows are validated
 * against each other, and the cluster is checked for the handful of things
 * whose absence would otherwise surface as a Pending pod with no log.
 */
export default defineComponent({
  name: 'NewBuildPage',

  mixins: [rawTranslations],

  components: {
    AsyncButton, Banner, Checkbox, ExtensionPicker, LabeledInput, Loading, PreflightBanners, ShellSourceForm
  },

  data() {
    return {
      loading: true,
      shell:   {
        repo: `${ DASHBOARD_REPO }.git`, pr: null, ref: null
      } as ShellSource,
      shellValid:      false,
      rows:            [] as PickerRow[],
      extensionsValid: false,
      buildDashboard:  false,
      dashboardHost:   '',
      dashboardTls:    true,
      preflight:       [] as PreflightResult[],
      submitError:     null as string | null,
      fixError:        null as string | null,
      clusters:        [] as ClusterOption[],
      /** Set when a remedy was applied somewhere other than local. */
      fixedElsewhere:  null as string | null
    };
  },

  computed: {
    blocked(): boolean {
      return preflightBlocked(this.preflight);
    },

    /**
     * Without an Ingress host the dashboard bundle has nowhere the browser can
     * reach it, and the build would bake in a URL that resolves to nothing.
     */
    dashboardValid(): boolean {
      return !this.buildDashboard || !!this.dashboardHost.trim();
    },

    canSubmit(): boolean {
      return !this.blocked && this.shellValid && this.extensionsValid && this.dashboardValid;
    },

    publicUrl(): string {
      return this.buildDashboard ? dashboardPublicUrl(this.dashboardHost, this.dashboardTls) : '';
    },

    selectedExtensions(): ExtensionSource[] {
      return this.rows
        .filter((row) => row.selected)
        .map((row) => ({
          name:     row.name.trim(),
          repo:     row.repo.trim(),
          ref:      (row.ref || '').trim(),
          pkg:      row.pkg.trim(),
          official: row.official
        }));
    }
  },

  async mounted() {
    await Promise.all([this.runChecks(), this.prefillFrom()]);
    this.loading = false;
  },

  methods: {
    async runChecks() {
      this.clusters = clusterOptions(this.$store);

      const [storageClasses, hasLocalPath, hasNamespace, hasNginxConfig] = await Promise.all([
        listStorageClasses(this.$store),
        localPathProvisionerPresent(this.$store),
        namespaceExists(this.$store),
        nginxConfigExists(this.$store)
      ]);

      this.preflight = runPreflight({
        isAdmin:               isAdminUser(this.$store.getters),
        hasClusterRepoSchema:  !!schemaFor(this.$store, STEVE_TYPES.CLUSTER_REPO),
        hasJobSchema:          !!schemaFor(this.$store, STEVE_TYPES.JOB),
        defaultStorageClasses: countDefaultStorageClasses(storageClasses),
        storage:               storageRemedy(storageClasses, hasLocalPath),
        namespaceExists:       hasNamespace,
        nginxConfigExists:     hasNginxConfig
      });
    },

    /**
     * Repair one preflight failure, then re-check everything.
     *
     * Re-checking rather than optimistically clearing the banner keeps the form
     * honest: the namespace fix also creates the nginx config, and a fix that
     * was quietly rejected has to stay blocking.
     */
    async fix(result: PreflightResult, done: (ok: boolean) => void, clusterId = LOCAL_CLUSTER) {
      this.fixError = null;
      this.fixedElsewhere = null;

      try {
        switch (result.fixable) {
        case 'namespace':
          await ensureNamespace(this.$store);
          break;
        case 'nginxConfig':
          await ensureNginxConfig(this.$store);
          break;
        case 'storageClass':
          await ensureDefaultStorageClass(this.$store, clusterId);

          if (clusterId !== LOCAL_CLUSTER) {
            // The banner is about local and will still be there afterwards,
            // which looks like the fix failed. Say what actually happened.
            this.fixedElsewhere = clusterId;
          }
          break;
        default:
          done(false);

          return;
        }

        await this.runChecks();
        done(true);
      } catch (e) {
        this.fixError = (e as Error).message;
        done(false);
      }
    },

    /** "Re-run" on the list lands here with ?from=<build id>. */
    async prefillFrom() {
      const from = this.$route.query.from;
      const id = Array.isArray(from) ? from[0] : from;

      if (!id) {
        return;
      }

      const configMap = await findOrNull(this.$store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ buildName(String(id)) }`);
      const spec = specFromAnnotations(configMap?.metadata?.annotations);

      if (!spec) {
        return;
      }

      this.shell = spec.shell;
      this.buildDashboard = spec.buildDashboard;
      this.rows = spec.extensions.map((ext) => ({
        ...ext, selected: true, versions: []
      }));

      if (spec.dashboard?.publicUrl) {
        try {
          const url = new URL(spec.dashboard.publicUrl);

          this.dashboardHost = url.host;
          this.dashboardTls = url.protocol === 'https:';
        } catch {
          // A spec written by an older build, or edited by hand. Leave the
          // field blank rather than guessing - the user has to fill it in.
        }
      }
    },

    async submit(done: (ok: boolean) => void) {
      this.submitError = null;

      try {
        const id = generateBuildId(this.shell);
        const spec = buildSpecFor({
          id,
          shell:              this.shell,
          extensions:         this.selectedExtensions,
          buildDashboard:     this.buildDashboard,
          dashboardPublicUrl: this.publicUrl
        });

        await createBuild(this.$store, spec);
        done(true);
        this.$router.push({ name: ROUTE_BUILDS, query: { id } });
      } catch (e) {
        this.submitError = (e as Error).message;
        done(false);
      }
    },

    cancel() {
      this.$router.push({ name: ROUTE_BUILDS });
    }
  }
});
</script>

<template>
  <div class="new-build">
    <h1>{{ t('extensionsBuilder.new.title') }}</h1>
    <p class="intro text-muted">
      {{ t('extensionsBuilder.new.intro') }}
    </p>

    <Loading v-if="loading" />

    <template v-else>
      <PreflightBanners
        :results="preflight"
        :clusters="clusters"
        @fix="fix"
      />

      <Banner
        v-if="fixedElsewhere"
        color="info"
      >
        <span>{{ t('extensionsBuilder.preflight.fix.otherCluster', { cluster: fixedElsewhere }) }}</span>
      </Banner>

      <Banner
        v-if="fixError"
        color="error"
        role="alert"
        :label="t('extensionsBuilder.preflight.fix.failed', { error: fixError })"
      />

      <section class="panel">
        <h3>{{ t('extensionsBuilder.new.shell.title') }}</h3>
        <p class="text-muted">
          {{ t('extensionsBuilder.new.shell.description') }}
        </p>
        <ShellSourceForm
          v-model="shell"
          @validity="shellValid = $event"
        />
      </section>

      <section class="panel">
        <h3>{{ t('extensionsBuilder.new.extensions.title') }}</h3>
        <p class="text-muted">
          {{ t('extensionsBuilder.new.extensions.description') }}
        </p>
        <ExtensionPicker
          v-model="rows"
          @validity="extensionsValid = $event"
        />
      </section>

      <section class="panel">
        <h3>{{ t('extensionsBuilder.new.options.title') }}</h3>

        <Checkbox
          v-model:value="buildDashboard"
          :label="t('extensionsBuilder.new.options.buildDashboard')"
          :tooltip="t('extensionsBuilder.new.options.buildDashboardTooltip')"
        />
        <p class="text-muted hint">
          {{ t('extensionsBuilder.new.options.buildDashboardHint') }}
        </p>

        <template v-if="buildDashboard">
          <div class="row mt-10">
            <div class="col span-8">
              <LabeledInput
                v-model:value="dashboardHost"
                :label="t('extensionsBuilder.new.options.dashboardHost')"
                :tooltip="t('extensionsBuilder.new.options.dashboardHostTooltip')"
                :required="true"
                placeholder="builder.example.com"
              />
            </div>
            <div class="col span-4 tls-col">
              <Checkbox
                v-model:value="dashboardTls"
                :label="t('extensionsBuilder.new.options.dashboardTls')"
              />
            </div>
          </div>

          <p
            v-if="publicUrl"
            class="text-muted hint"
          >
            {{ t('extensionsBuilder.new.options.resolvedUrl', { url: publicUrl }) }}
          </p>

          <Banner
            color="warning"
            :label="t('extensionsBuilder.new.options.dashboardWarning')"
          />
        </template>
      </section>

      <Banner
        v-if="submitError"
        color="error"
        role="alert"
        :label="submitError"
      />

      <div class="actions">
        <button
          type="button"
          class="btn role-secondary"
          @click="cancel"
        >
          {{ t('generic.cancel') }}
        </button>
        <AsyncButton
          mode="create"
          :disabled="!canSubmit"
          :action-label="t('extensionsBuilder.new.submit')"
          @click="submit"
        />
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.intro {
  margin: 8px 0 20px 0;
  max-width: 80ch;
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

.hint {
  font-size: 12px;
  margin: 6px 0 0 0;
}

.tls-col {
  align-items: flex-end;
  display: flex;
  padding-bottom: 8px;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
