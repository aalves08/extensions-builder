<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { Banner } from '@components/Banner';
import { LabeledInput } from '@components/Form/LabeledInput';
import { RadioGroup } from '@components/Form/Radio';
import { DASHBOARD_REPO } from '../config/builder';
import { ShellSource } from '../types';
import {
  GithubError, PullRequestInfo, cloneUrl, fetchPullRequest, parsePullRequestNumber, parseRepoRef, refExists
} from '../utils/github';
import rawTranslations from '../utils/i18n';

/** Long enough that typing "1234" is one request, not four. */
const DEBOUNCE_MS = 600;

/**
 * Where the shell under test comes from.
 *
 * Resolving the input against GitHub as the user types is the point of this
 * component: a typo'd PR number is otherwise a 30 minute build that fails in
 * its first phase, and seeing the PR title is the cheapest possible
 * confirmation that it is the right one.
 */
export default defineComponent({
  name: 'ShellSourceForm',

  mixins: [rawTranslations],

  components: {
    Banner, LabeledInput, RadioGroup
  },

  props: {
    modelValue: {
      type:     Object as PropType<ShellSource>,
      required: true
    }
  },

  emits: ['update:modelValue', 'validity'],

  data() {
    return {
      mode:     this.modelValue.ref ? 'ref' : 'pr',
      repo:     this.modelValue.repo || `${ DASHBOARD_REPO }.git`,
      prInput:  this.modelValue.pr ? String(this.modelValue.pr) : '',
      refInput: this.modelValue.ref || '',
      checking: false,
      pr:       null as PullRequestInfo | null,
      refOk:    false,
      error:    null as string | null,
      timer:    null as ReturnType<typeof setTimeout> | null
    };
  },

  computed: {
    modeOptions() {
      return [
        { label: this.t('extensionsBuilder.new.shell.modePr'), value: 'pr' },
        { label: this.t('extensionsBuilder.new.shell.modeRef'), value: 'ref' }
      ];
    },

    repoRef() {
      return parseRepoRef(this.repo);
    },

    resolved(): boolean {
      return this.mode === 'pr' ? !!this.pr : this.refOk;
    }
  },

  watch: {
    mode() {
      this.reset();
    },
    repo() {
      this.queueCheck();
    },
    prInput() {
      this.queueCheck();
    },
    refInput() {
      this.queueCheck();
    }
  },

  mounted() {
    this.queueCheck();
  },

  beforeUnmount() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
  },

  methods: {
    reset() {
      this.pr = null;
      this.refOk = false;
      this.error = null;
      this.queueCheck();
    },

    queueCheck() {
      if (this.timer) {
        clearTimeout(this.timer);
      }

      this.emitValue();
      this.timer = setTimeout(() => this.check(), DEBOUNCE_MS);
    },

    emitValue() {
      const source: ShellSource = {
        repo: this.repo.trim(),
        pr:   this.mode === 'pr' ? parsePullRequestNumber(this.prInput) : null,
        ref:  this.mode === 'ref' ? this.refInput.trim() : null
      };

      this.$emit('update:modelValue', source);
      this.$emit('validity', this.resolved);
    },

    async check() {
      const ref = this.repoRef;

      this.pr = null;
      this.refOk = false;

      if (!ref) {
        this.error = this.repo.trim() ? this.t('extensionsBuilder.new.shell.badRepo') : null;
        this.emitValue();

        return;
      }

      const input = this.mode === 'pr' ? this.prInput.trim() : this.refInput.trim();

      if (!input) {
        this.error = null;
        this.emitValue();

        return;
      }

      this.checking = true;
      this.error = null;

      try {
        if (this.mode === 'pr') {
          const number = parsePullRequestNumber(this.prInput);

          if (!number) {
            this.error = this.t('extensionsBuilder.new.shell.badPr');
          } else {
            this.pr = await fetchPullRequest(ref, number);
            // Keep the field tidy when someone pasted a whole PR URL.
            this.prInput = String(number);
          }
        } else {
          this.refOk = await refExists(ref, this.refInput.trim());

          if (!this.refOk) {
            this.error = this.t('extensionsBuilder.new.shell.noSuchRef');
          }
        }
      } catch (e) {
        // 403 here is almost always the 60/hour unauthenticated rate limit, and
        // telling someone "no such PR" when they are simply rate limited sends
        // them looking in entirely the wrong place.
        const status = e instanceof GithubError ? e.status : 0;

        this.error = status === 403 ? this.t('extensionsBuilder.new.shell.rateLimited') : this.t('extensionsBuilder.new.shell.noSuchPr');
      } finally {
        this.checking = false;
        this.emitValue();
      }
    },

    /** Only used for display - the builder does its own clone. */
    canonicalRepo(): string {
      return this.repoRef ? cloneUrl(this.repoRef) : this.repo;
    }
  }
});
</script>

<template>
  <div class="shell-source">
    <RadioGroup
      v-model:value="mode"
      name="shell-mode"
      :options="modeOptions"
      :label="t('extensionsBuilder.new.shell.mode')"
      :row="true"
    />

    <div class="row mt-10">
      <div class="col span-6">
        <LabeledInput
          v-model:value="repo"
          :label="t('extensionsBuilder.new.shell.repo')"
          :tooltip="t('extensionsBuilder.new.shell.repoTooltip')"
          placeholder="https://github.com/rancher/dashboard.git"
          :disabled="true"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-if="mode === 'pr'"
          v-model:value="prInput"
          :label="t('extensionsBuilder.new.shell.pr')"
          :tooltip="t('extensionsBuilder.new.shell.prTooltip')"
          placeholder="13579"
        />
        <LabeledInput
          v-else
          v-model:value="refInput"
          :label="t('extensionsBuilder.new.shell.ref')"
          :tooltip="t('extensionsBuilder.new.shell.refTooltip')"
          placeholder="master"
        />
      </div>
    </div>

    <Banner
      v-if="checking"
      color="info"
      :label="t('extensionsBuilder.new.shell.checking')"
    />

    <Banner
      v-else-if="error"
      color="error"
      role="alert"
      :label="error"
    />

    <Banner
      v-else-if="pr"
      :color="pr.draft || pr.state !== 'open' ? 'warning' : 'success'"
    >
      <div>
        <strong>#{{ pr.number }}</strong> {{ pr.title }}
      </div>
      <div class="text-muted">
        {{ t('extensionsBuilder.new.shell.prMeta', { author: pr.author, branch: pr.branch, sha: pr.sha.slice(0, 12) }) }}
        <template v-if="pr.draft">
          &middot; {{ t('extensionsBuilder.new.shell.draft') }}
        </template>
        <template v-if="pr.state !== 'open'">
          &middot; {{ pr.state }}
        </template>
      </div>
    </Banner>

    <Banner
      v-else-if="refOk"
      color="success"
      :label="t('extensionsBuilder.new.shell.refOk', { ref: refInput })"
    />
  </div>
</template>

<style lang="scss" scoped>
.shell-source {
  :deep(.banner) {
    margin-top: 16px;
  }
}
</style>
