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
import {
  DASHBOARD_BUILD_ENABLED, DASHBOARD_REPO, NAMESPACE, ROUTE_BUILDS, buildName, repoPublicUrl
} from '../config/builder';
import {
  ExtensionSource, ExternalAccess, PickerRow, PreflightResult, ShellSource
} from '../types';
import {
  createBuild,
  ensureDefaultStorageClass,
  ensureNamespace,
  ensureNginxConfig,
  findOrNull,
  listStorageClasses,
  localPathProvisionerPresent,
  namespaceExists,
  nginxConfigCurrent,
  schemaFor
} from '../utils/api';
import { STEVE_TYPES, buildSpecFor, dashboardPublicUrl, generateBuildId } from '../utils/build-resources';
import { ExternalAccessReason, defaultExternalAccess } from '../utils/server-url';
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
      /** Off until we find an address worth offering - see prefillExternal. */
      externalEnabled: false,
      external:        {
        host: '', tls: true, tlsSecretName: ''
      } as ExternalAccess,
      /** Why external access is not on offer at all, when it is not. */
      externalBlocked: null as { reason: ExternalAccessReason; address: string } | null,
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

    /** Exposed to the template, which cannot see module constants. */
    dashboardBuildEnabled(): boolean {
      return DASHBOARD_BUILD_ENABLED;
    },

    /**
     * Without an Ingress host the dashboard bundle has nowhere the browser can
     * reach it, and the build would bake in a URL that resolves to nothing.
     */
    dashboardValid(): boolean {
      return !this.buildDashboard || !!this.dashboardHost.trim();
    },

    externalValid(): boolean {
      return !this.externalEnabled || !!this.external.host.trim();
    },

    /** Why the option is unavailable, in words, or '' when it is available. */
    externalBlockedMessage(): string {
      if (!this.externalBlocked) {
        return '';
      }

      return this.t(
        `extensionsBuilder.new.external.blocked.${ this.externalBlocked.reason }`,
        { address: this.externalBlocked.address }
      );
    },

    /** What the build's repository will be reachable at, if anything. */
    externalAccess(): ExternalAccess | null {
      return this.externalEnabled && this.external.host.trim() ? this.external : null;
    },

    /**
     * The URL with the build id still to come. There is no id until submit,
     * and the shape of the URL is the part worth checking beforehand.
     */
    externalUrlPreview(): string {
      return this.externalAccess ? repoPublicUrl(this.external.host, this.external.tls, '<build id>') : '';
    },

    canSubmit(): boolean {
      return !this.blocked && this.shellValid && this.extensionsValid && this.dashboardValid && this.externalValid;
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
    await Promise.all([this.runChecks(), this.prefillExternal()]);
    // After, not alongside: re-running a build should reproduce the addresses
    // it was built with, not whatever this Rancher would suggest today.
    await this.prefillFrom();
    this.loading = false;
  },

  methods: {
    async runChecks() {
      this.clusters = clusterOptions(this.$store);

      const [storageClasses, hasNamespace, hasNginxConfig] = await Promise.all([
        listStorageClasses(this.$store),
        namespaceExists(this.$store),
        nginxConfigCurrent(this.$store)
      ]);

      // Only worth asking when there is no StorageClass at all - that is the
      // one case where the answer decides anything (create a class for a
      // provisioner already running, or install one first). Asking always
      // costs two requests and logs a 404 in the console of every healthy
      // cluster, for a result that is then discarded.
      const hasLocalPath = !storageClasses.length && await localPathProvisionerPresent(this.$store);

      this.preflight = runPreflight({
        isAdmin:               isAdminUser(this.$store.getters),
        hasClusterRepoSchema:  !!schemaFor(this.$store, STEVE_TYPES.CLUSTER_REPO),
        hasJobSchema:          !!schemaFor(this.$store, STEVE_TYPES.JOB),
        defaultStorageClasses: countDefaultStorageClasses(storageClasses),
        storage:               storageRemedy(storageClasses, hasLocalPath),
        namespaceExists:       hasNamespace,
        nginxConfigCurrent:    hasNginxConfig
      });
    },

    /**
     * Fill the external access fields in from the address this Rancher answers
     * on, or explain why there is no such address.
     *
     * Only ever a starting point, so the fields stay editable - `server-url`
     * routes here by definition, but a Rancher run straight from a container
     * publishes a port rather than going through an ingress, and there the
     * hostname is right and the route does not exist. When nothing qualifies
     * the option is turned off and locked: this is a fact about where Rancher
     * is running and not something a different value in the box would fix, and
     * an address that cannot work is worse than no address at all once it has
     * been baked into the charts.
     */
    async prefillExternal() {
      const suggestion = await defaultExternalAccess(this.$store);

      if (!suggestion.access) {
        this.externalBlocked = { reason: suggestion.reason, address: suggestion.address };

        return;
      }

      this.external = { ...suggestion.access, tlsSecretName: '' };
      this.externalEnabled = true;
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
      // Never restore a toggle the form no longer shows: re-running an older
      // build would otherwise ask for a dashboard with no way to set its host,
      // and nothing on screen to explain why submit is disabled.
      this.buildDashboard = DASHBOARD_BUILD_ENABLED && spec.buildDashboard;
      this.rows = spec.extensions.map((ext) => ({
        ...ext, selected: true, versions: []
      }));

      if (spec.external?.host) {
        this.external = { tlsSecretName: '', ...spec.external };
        this.externalEnabled = true;
        // Whatever this Rancher would suggest today, an address that was good
        // enough to build against once is not ours to withdraw on a re-run.
        this.externalBlocked = null;
      }

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
          dashboardPublicUrl: this.publicUrl,
          external:           this.externalAccess
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
        <h3>{{ t('extensionsBuilder.new.external.title') }}</h3>
        <p class="text-muted mb-20">
          {{ t('extensionsBuilder.new.external.description') }}
        </p>

        <Banner
          v-if="externalBlockedMessage"
          color="warning"
          :label="externalBlockedMessage"
        />

        <Checkbox
          v-model:value="externalEnabled"
          :disabled="!!externalBlocked"
          :label="t('extensionsBuilder.new.external.enable')"
          :tooltip="t('extensionsBuilder.new.external.enableTooltip')"
        />

        <template v-if="externalEnabled">
          <div class="row mt-10">
            <div class="col span-8">
              <LabeledInput
                v-model:value="external.host"
                :label="t('extensionsBuilder.new.external.host')"
                :tooltip="t('extensionsBuilder.new.external.hostTooltip')"
                :required="true"
                placeholder="rancher.example.com"
              />
            </div>
            <div class="col span-4 tls-col">
              <Checkbox
                v-model:value="external.tls"
                :label="t('extensionsBuilder.new.external.tls')"
              />
            </div>
          </div>

          <div class="row mt-10">
            <div class="col span-8">
              <LabeledInput
                v-model:value="external.tlsSecretName"
                :label="t('extensionsBuilder.new.external.tlsSecret')"
                :tooltip="t('extensionsBuilder.new.external.tlsSecretTooltip')"
                :placeholder="t('extensionsBuilder.new.external.tlsSecretPlaceholder')"
              />
            </div>
          </div>

          <p
            v-if="externalUrlPreview"
            class="text-muted hint"
          >
            {{ t('extensionsBuilder.new.external.resolvedUrl', { url: externalUrlPreview }) }}
          </p>

          <Banner
            color="info"
            :label="t('extensionsBuilder.new.external.note')"
          />
        </template>
      </section>

      <!--
        Hidden, not removed - see DASHBOARD_BUILD_ENABLED. The whole section
        goes, because the dashboard toggle is the only thing in it and an empty
        "Options" panel is worse than none.
      -->
      <section
        v-if="dashboardBuildEnabled"
        class="panel"
      >
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
