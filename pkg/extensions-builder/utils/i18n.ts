import { defineComponent } from 'vue';
import { stringFor } from '@shell/plugins/i18n';

/**
 * Shadows the global `t` with one that does not HTML-escape.
 *
 * The shell's `t` escapes by default (`shell/plugins/i18n.js`), because the
 * shell's own idiom is `v-clean-html="t(...)"` and the `<t>` component, both of
 * which set innerHTML and so decode the entities again. We render translations
 * as text - `{{ t(...) }}`, `:label`, `:tooltip` - and text interpolation does
 * not decode, so an apostrophe reaches the screen as `&#39;` and `<n>` as
 * `&lt;n&gt;`.
 *
 * Raw is also correct for the places we pass a translation to something that
 * does render HTML: Banner escapes its `label` itself, and the tooltip
 * directive sanitises. So nothing here wants a pre-escaped string.
 *
 * Every component that renders a translation should mix this in. `stringFor`
 * is the shell's own implementation, so the missing-key behaviour (`%key%`)
 * stays exactly as it is everywhere else in Rancher.
 */
export default defineComponent({
  methods: {
    t(key: string, args?: Record<string, unknown>): string {
      // The shell types `this.$store` as its own VuexStore shim, which is not
      // the vuex Store the JSDoc on stringFor names. Same object at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return stringFor(this.$store as any, key, args, true);
    }
  }
});
