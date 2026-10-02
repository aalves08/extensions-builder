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
 * source lives. What it does not do is pin you to the released thing - the
 * whole reason to run this is usually "my branch of kubewarden against this
 * shell PR", so the branch or tag of an official row is editable.
 *
 * Its identity is not. Name, package and repository together are what make the
 * row that extension, and editing them produces something mislabelled at best
 * and unbuildable at worst, so they are locked. Build whatever you like from a
 * repository row instead: those have no identity to protect.
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

          <!--
            Two rows, not one: .row is a non-wrapping flex container and .col is
            flex: 0 0 auto, so a span-12 sitting alongside three span-4s adds up
            to 200% and hangs off the right edge of the panel rather than
            wrapping under them.
          -->
          <div
            v-if="expanded[index]"
            class="editor mt-10"
          >
            <p
              v-if="row.official"
              class="text-muted hint"
            >
              {{ t('extensionsBuilder.new.extensions.officialHint') }}
            </p>

            <div class="row">
              <div class="col span-4">
                <LabeledInput
                  v-model:value="row.name"
                  :label="t('extensionsBuilder.new.extensions.name')"
                  :disabled="row.official"
                  :tooltip="row.official
                    ? t('extensionsBuilder.new.extensions.nameLockedTooltip')
                    : t('extensionsBuilder.new.extensions.nameTooltip')"
                />
              </div>
              <div class="col span-4">
                <LabeledInput
                  v-model:value="row.pkg"
                  :label="t('extensionsBuilder.new.extensions.pkg')"
                  :disabled="row.official"
                  :tooltip="row.official
                    ? t('extensionsBuilder.new.extensions.pkgLockedTooltip')
                    : t('extensionsBuilder.new.extensions.pkgTooltip')"
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
            </div>

            <!--
              An official row's name, package and repository are between them
              what make it that extension: the repository is where the source
              comes from, the package is the folder under pkg/ that is actually
              built, and the name goes on the chart and the installed UIPlugin.
              Change any of them and you no longer have the extension the row
              says you have - most likely you have a build that fails, because
              the package does not exist in that tree. They are shown for
              confirmation only. The branch or tag stays editable, since
              building someone's extension from a branch other than their
              default is the whole point. To build something genuinely
              different, add a repository instead - nothing about those rows is
              fixed, so every field is editable.
            -->
            <div class="row mt-10">
              <div class="col span-12">
                <LabeledInput
                  v-model:value="row.repo"
                  :label="t('extensionsBuilder.new.extensions.repo')"
                  :disabled="row.official"
                  :tooltip="row.official ? t('extensionsBuilder.new.extensions.repoLockedTooltip') : undefined"
                  placeholder="https://github.com/rancher/kubewarden-ui.git"
                />
              </div>
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

.hint {
  font-size: 12px;
  margin: 0 0 10px 0;
}
</style>
