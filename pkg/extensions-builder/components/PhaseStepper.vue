<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { BuildPhase } from '../types';
import { formatDuration } from '../utils/build-log';
import rawTranslations from '../utils/i18n';

/**
 * The five build phases as a vertical stepper.
 *
 * A build runs for 20-40 minutes, so "it is doing something" is not good
 * enough - someone coming back to the tab needs to see how far it got and,
 * when it failed, which phase failed. The phases come from the pod log; see
 * utils/build-log.ts.
 */
export default defineComponent({
  name: 'PhaseStepper',

  mixins: [rawTranslations],

  props: {
    phases: {
      type:    Array as PropType<BuildPhase[]>,
      default: () => []
    }
  },

  methods: {
    iconFor(state: string): string {
      switch (state) {
      case 'success': return 'icon-checkmark';
      case 'failed': return 'icon-error';
      case 'running': return 'icon-spinner icon-spin';
      case 'skipped': return 'icon-minus';
      default: return 'icon-dot-open';
      }
    },

    labelFor(name: string): string {
      return this.t(`extensionsBuilder.phases.${ name }`);
    },

    /**
     * How long the phase took. Only once it is over - a half-finished number
     * ticking up next to a spinner says nothing the spinner does not.
     */
    durationFor(phase: BuildPhase): string {
      return formatDuration(phase.durationSeconds);
    }
  }
});
</script>

<template>
  <ol class="phase-stepper">
    <li
      v-for="phase in phases"
      :key="phase.name"
      :class="['phase', `phase--${ phase.state }`]"
    >
      <i
        class="icon phase__icon"
        :class="iconFor(phase.state)"
        aria-hidden="true"
      />
      <span class="phase__label">{{ labelFor(phase.name) }}</span>
      <span
        v-if="durationFor(phase)"
        class="phase__duration"
      >{{ durationFor(phase) }}</span>
      <span class="phase__state">{{ t(`extensionsBuilder.phaseState.${ phase.state }`) }}</span>
    </li>
  </ol>
</template>

<style lang="scss" scoped>
.phase-stepper {
  list-style: none;
  margin: 0;
  padding: 0;
}

.phase {
  align-items: center;
  border-left: 1px solid var(--border);
  display: flex;
  gap: 8px;
  margin-left: 8px;
  padding: 8px 0 8px 16px;
  position: relative;

  &:first-child {
    border-top-left-radius: var(--border-radius);
  }

  &__icon {
    background: var(--body-bg);
    left: -9px;
    position: absolute;
  }

  &__label {
    flex: 1;
  }

  // Tabular figures so the column of times lines up and can be read down.
  &__duration {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  &__state {
    color: var(--muted);
    font-size: 12px;
    min-width: 62px;
    text-align: right;
    text-transform: uppercase;
  }

  &--pending {
    color: var(--muted);
  }

  &--success .phase__icon {
    color: var(--success);
  }

  &--failed {
    color: var(--error);

    .phase__icon {
      color: var(--error);
    }
  }

  &--running .phase__icon {
    color: var(--primary);
  }

  &--skipped {
    color: var(--muted);
  }
}
</style>
