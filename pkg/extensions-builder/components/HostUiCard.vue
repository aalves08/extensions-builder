<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { HostUiState, applyHostUi, readHostUiState, revertHostUi } from '../utils/host-ui';
import rawTranslations from '../utils/i18n';

/**
 * The card that points Rancher's own UI at a build.
 *
 * Deliberately separate from everything else on the detail page, and
 * deliberately noisy about it: this rewrites two global settings and changes
 * what every other user of this Rancher sees on their next page load. The
 * revert is always offered, and the values it restores were stashed when the
 * swap was applied - see utils/host-ui.ts.
 */
export default defineComponent({
  name: 'HostUiCard',

  mixins: [rawTranslations],

  components: { AsyncButton, Banner },

  props: {
    buildId: {
      type:     String,
      required: true
    },

    /** index.html URL the build reported. Empty until the build emits it. */
    indexUrl: {
      type:    String,
      default: ''
    }
  },

  data() {
    return {
      state: null as HostUiState | null,
      error: null as string | null
    };
  },

  computed: {
    /** Something was stashed, so a revert is meaningful even if we are not active. */
    canRevert(): boolean {
      return this.state?.previousIndex !== null && this.state?.previousIndex !== undefined;
    },

    isActive(): boolean {
      return !!this.state?.active;
    }
  },

  async mounted() {
    await this.refresh();
  },

  methods: {
    async refresh() {
      try {
        this.state = await readHostUiState(this.$store, this.buildId, this.indexUrl);
        this.error = null;
      } catch (e) {
        this.error = (e as Error).message;
      }
    },

    async apply(done: (ok: boolean) => void) {
      try {
        await applyHostUi(this.$store, this.buildId, this.indexUrl);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = (e as Error).message;
        done(false);
      }
    },

    async revert(done: (ok: boolean) => void) {
      try {
        await revertHostUi(this.$store, this.buildId);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = (e as Error).message;
        done(false);
      }
    }
  }
});
</script>

<template>
  <div class="host-ui-card">
    <h3>{{ t('extensionsBuilder.hostUi.title') }}</h3>
    <p class="text-muted">
      {{ t('extensionsBuilder.hostUi.description') }}
    </p>

    <Banner
      color="warning"
      :label="t('extensionsBuilder.hostUi.warning')"
    />

    <Banner
      v-if="error"
      color="error"
      role="alert"
      :label="error"
    />

    <Banner
      v-else-if="!indexUrl"
      color="info"
      :label="t('extensionsBuilder.hostUi.noIndex')"
    />

    <template v-else>
      <dl class="settings">
        <dt>{{ t('extensionsBuilder.hostUi.buildIndex') }}</dt>
        <dd><code>{{ indexUrl }}</code></dd>
        <dt>{{ t('extensionsBuilder.hostUi.currentIndex') }}</dt>
        <dd><code>{{ state?.index || t('extensionsBuilder.hostUi.unset') }}</code></dd>
        <dt>{{ t('extensionsBuilder.hostUi.offlinePreferred') }}</dt>
        <dd><code>{{ state?.offlinePreferred || t('extensionsBuilder.hostUi.unset') }}</code></dd>
      </dl>

      <Banner
        v-if="isActive"
        color="success"
        :label="t('extensionsBuilder.hostUi.active')"
      />

      <div class="actions">
        <AsyncButton
          v-if="!isActive"
          mode="apply"
          :action-label="t('extensionsBuilder.hostUi.apply')"
          @click="apply"
        />
        <AsyncButton
          v-if="canRevert"
          mode="apply"
          action-color="role-secondary"
          :action-label="t('extensionsBuilder.hostUi.revert')"
          @click="revert"
        />
      </div>

      <p class="text-muted reload-hint">
        {{ t('extensionsBuilder.hostUi.reloadHint') }}
      </p>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.host-ui-card {
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  padding: 16px;

  h3 {
    margin-top: 0;
  }
}

.settings {
  display: grid;
  gap: 4px 16px;
  grid-template-columns: max-content 1fr;
  margin: 16px 0;

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.reload-hint {
  margin-top: 12px;
}
</style>
