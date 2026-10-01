<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton.vue';
import ClusterSelect from '@shell/components/form/Select.vue';
import { PreflightResult } from '../types';
import { preflightFailures, preflightWarnings } from '../utils/preflight';
import { ClusterOption } from '../utils/clusters';
import { LOCAL_CLUSTER } from '../utils/steve-proxy';
import rawTranslations from '../utils/i18n';

/**
 * The results of the pre-submit checks.
 *
 * Failures block; warnings do not. Nothing is shown when everything passed -
 * a wall of green ticks on a form is noise.
 *
 * A failure the UI can repair itself carries a `fixable` remedy name and gets
 * a button alongside the message. The parent owns what the button does; this
 * component only reports which result was clicked, and against which cluster.
 */
export default defineComponent({
  name: 'PreflightBanners',

  mixins: [rawTranslations],

  components: {
    AsyncButton, Banner, ClusterSelect
  },

  props: {
    results: {
      type:    Array as PropType<PreflightResult[]>,
      default: () => []
    },

    /** Clusters a cluster-targeted remedy may be applied to. Local is first. */
    clusters: {
      type:    Array as PropType<ClusterOption[]>,
      default: () => []
    }
  },

  emits: ['fix'],

  data() {
    /** Chosen target per check. Local until the user says otherwise. */
    return { targets: {} as Record<string, string> };
  },

  computed: {
    failures(): PreflightResult[] {
      return preflightFailures(this.results);
    },

    warnings(): PreflightResult[] {
      return preflightWarnings(this.results);
    }
  },

  methods: {
    message(result: PreflightResult): string {
      return this.t(result.messageKey, result.messageArgs || {});
    },

    /**
     * One remedy can mean two rather different things - "annotate a class" and
     * "install a provisioner into this cluster" are both `storageClass` - so a
     * check may name its own label rather than take the default for its remedy.
     */
    fixLabel(result: PreflightResult): string {
      const key = result.fixLabelKey || `extensionsBuilder.preflight.fix.${ result.fixable }`;

      return this.t(key, result.messageArgs || {});
    },

    target(result: PreflightResult): string {
      return this.targets[result.id] || LOCAL_CLUSTER;
    },

    setTarget(result: PreflightResult, value: string) {
      this.targets = { ...this.targets, [result.id]: value };
    },

    /** Only worth a picker when there is actually more than one answer. */
    showClusters(result: PreflightResult): boolean {
      return !!result.fixCluster && this.clusters.length > 1;
    }
  }
});
</script>

<template>
  <div v-if="failures.length || warnings.length">
    <Banner
      v-for="result in failures"
      :key="result.id"
      color="error"
      role="alert"
    >
      <div class="preflight-banner">
        <span>{{ message(result) }}</span>
        <div
          v-if="result.fixable"
          class="preflight-banner__actions"
        >
          <ClusterSelect
            v-if="showClusters(result)"
            class="preflight-banner__cluster"
            :options="clusters"
            :value="target(result)"
            :clearable="false"
            :searchable="false"
            option-label="label"
            option-key="value"
            :reduce="(option) => option.value"
            :aria-label="t('extensionsBuilder.preflight.fix.targetCluster')"
            @update:value="(value) => setTarget(result, value)"
          />
          <AsyncButton
            mode="apply"
            size="sm"
            :action-label="fixLabel(result)"
            @click="(done) => $emit('fix', result, done, target(result))"
          />
        </div>
      </div>
    </Banner>
    <Banner
      v-for="result in warnings"
      :key="result.id"
      color="warning"
    >
      <span>{{ message(result) }}</span>
    </Banner>
  </div>
</template>

<style lang="scss" scoped>
.preflight-banner {
  align-items: center;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  width: 100%;

  &__actions {
    align-items: center;
    display: flex;
    gap: 8px;

    // Neither control may shrink away when the message is long.
    flex-shrink: 0;
  }

  &__cluster {
    min-width: 180px;
  }
}
</style>
