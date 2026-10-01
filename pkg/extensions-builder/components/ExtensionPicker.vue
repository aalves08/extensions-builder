<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import Loading from '@shell/components/Loading.vue';
import { PickerRow } from '../types';
import { emptyRow, fetchManifest, validateRows } from '../utils/manifest';
import rawTranslations from '../utils/i18n';

/**
 * Which extensions to build.
 *
 * The official list is discovery only: it tells you what exists and where the
 * source lives, but every field stays editable, because the whole reason to
 * run this is usually "my branch of kubewarden against this shell PR" rather
 * than the released thing.
 */
export default defineComponent({
  name: 'ExtensionPicker',

  mixins: [rawTranslations],

  components: {
    Banner, Checkbox, LabeledInput, Loading
  },

  props: {
    modelValue: {
      type:    Array as PropType<PickerRow[]>,
      default: () => []
    }
  },

  emits: ['update:modelValue', 'validity'],

  data() {
    return {
      rows:          [...this.modelValue] as PickerRow[],
      loading:       this.modelValue.length === 0,
      manifestError: null as string | null,
      expanded:      {} as Record<number, boolean>
    };
  },

  computed: {
    errors(): Record<number, string> {
      return validateRows(this.rows);
    },

    selectedCount(): number {
      return this.rows.filter((row) => row.selected).length;
    },

    valid(): boolean {
      return this.selectedCount > 0 && Object.keys(this.errors).length === 0;
    }
  },

  watch: {
    rows: {
      deep: true,
      handler() {
        this.$emit('update:modelValue', this.rows);
        this.$emit('validity', this.valid);
      }
    }
  },

  async mounted() {
    if (this.rows.length) {
      this.$emit('validity', this.valid);

      return;
    }

    try {
      this.rows = await fetchManifest();
    } catch (e) {
      // Not fatal: the manifest is a convenience, and a hand-entered git URL
      // works just as well. Say so rather than blocking the form.
      this.manifestError = (e as Error).message;
    } finally {
      this.loading = false;
      this.$emit('update:modelValue', this.rows);
      this.$emit('validity', this.valid);
    }
  },

  methods: {
    toggleExpanded(index: number) {
      this.expanded = { ...this.expanded, [index]: !this.expanded[index] };
    },

    addCustom() {
      this.rows = [...this.rows, emptyRow()];
      this.expanded = { ...this.expanded, [this.rows.length - 1]: true };
    },

    removeRow(index: number) {
      this.rows = this.rows.filter((_row, i) => i !== index);
    },

    errorFor(index: number): string | null {
      const key = this.errors[index];

      return key ? this.t(key) : null;
    },

    latestVersion(row: PickerRow): string {
      return row.versions?.[0] || '';
    }
  }
});
</script>

<template>
  <div class="extension-picker">
    <Loading v-if="loading" />

    <template v-else>
      <Banner
        v-if="manifestError"
        color="warning"
        :label="t('extensionsBuilder.new.extensions.manifestFailed', { error: manifestError })"
      />

      <Banner
        v-if="!selectedCount"
        color="info"
        :label="t('extensionsBuilder.new.extensions.selectAtLeastOne')"
      />

      <ul class="rows">
        <li
          v-for="(row, index) in rows"
          :key="`${ index }-${ row.name }`"
          class="row-item"
          :class="{ 'row-item--selected': row.selected, 'row-item--invalid': !!errorFor(index) }"
        >
          <div class="row-head">
            <Checkbox
              v-model:value="row.selected"
              :label="row.name || t('extensionsBuilder.new.extensions.unnamed')"
            />
            <span
              v-if="latestVersion(row)"
              class="text-muted version"
            >{{ t('extensionsBuilder.new.extensions.latest', { version: latestVersion(row) }) }}</span>
            <span class="spacer" />
            <button
              type="button"
              class="btn btn-sm role-link"
              @click="toggleExpanded(index)"
            >
              {{ expanded[index] ? t('extensionsBuilder.new.extensions.hide') : t('extensionsBuilder.new.extensions.edit') }}
            </button>
            <button
              v-if="!row.official"
              type="button"
              class="btn btn-sm role-link text-error"
              @click="removeRow(index)"
            >
              {{ t('generic.remove') }}
            </button>
          </div>

          <p
            v-if="!expanded[index]"
            class="repo-line text-muted"
          >
            {{ row.repo }}<template v-if="row.ref">
              &middot; {{ row.ref }}
            </template>
          </p>

          <div
            v-if="expanded[index]"
            class="row mt-10"
          >
            <div class="col span-4">
              <LabeledInput
                v-model:value="row.name"
                :label="t('extensionsBuilder.new.extensions.name')"
                :tooltip="t('extensionsBuilder.new.extensions.nameTooltip')"
              />
            </div>
            <div class="col span-4">
              <LabeledInput
                v-model:value="row.pkg"
                :label="t('extensionsBuilder.new.extensions.pkg')"
                :tooltip="t('extensionsBuilder.new.extensions.pkgTooltip')"
              />
            </div>
            <div class="col span-4">
              <LabeledInput
                v-model:value="row.ref"
                :label="t('extensionsBuilder.new.extensions.ref')"
                :tooltip="t('extensionsBuilder.new.extensions.refTooltip')"
                :placeholder="t('extensionsBuilder.new.extensions.refPlaceholder')"
              />
            </div>
            <!--
              An official row's repository comes from rancher/ui-plugin-charts
              and is what makes it that extension. Editing it would leave a row
              labelled as one extension building another, so it is shown for
              confirmation only. Add a repository of your own instead - that
              row's URL is editable, since it is the only thing defining it.
            -->
            <div class="col span-12 mt-10">
              <LabeledInput
                v-model:value="row.repo"
                :label="t('extensionsBuilder.new.extensions.repo')"
                :disabled="row.official"
                :tooltip="row.official ? t('extensionsBuilder.new.extensions.repoLockedTooltip') : undefined"
                placeholder="https://github.com/rancher/kubewarden-ui.git"
              />
            </div>
          </div>

          <Banner
            v-if="errorFor(index)"
            color="error"
            role="alert"
            :label="errorFor(index)"
          />
        </li>
      </ul>

      <button
        type="button"
        class="btn role-secondary mt-10"
        @click="addCustom"
      >
        {{ t('extensionsBuilder.new.extensions.addCustom') }}
      </button>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row-item {
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  margin-bottom: 8px;
  padding: 10px 12px;

  &--selected {
    border-color: var(--primary);
  }

  &--invalid {
    border-color: var(--error);
  }
}

.row-head {
  align-items: center;
  display: flex;
  gap: 12px;
}

.spacer {
  flex: 1;
}

.version {
  font-size: 12px;
}

.repo-line {
  font-size: 12px;
  margin: 4px 0 0 24px;
  overflow-wrap: anywhere;
}
</style>
