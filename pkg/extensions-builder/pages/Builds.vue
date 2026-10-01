<script lang="ts">
import { defineComponent } from 'vue';
import BuildDetail from '../components/BuildDetail.vue';
import BuildList from '../components/BuildList.vue';

/**
 * Builds, list and detail.
 *
 * The New Product Registration API registers one component per side-nav entry,
 * and a build's detail page is not a nav entry - so it rides on this one as
 * `?id=<build>`. That also makes the detail page linkable and reload-safe,
 * which matters a lot for something that runs for half an hour.
 */
export default defineComponent({
  name: 'BuildsPage',

  components: { BuildDetail, BuildList },

  computed: {
    buildId(): string {
      const id = this.$route.query.id;

      return Array.isArray(id) ? String(id[0] || '') : String(id || '');
    }
  }
});
</script>

<template>
  <BuildDetail
    v-if="buildId"
    :key="buildId"
    :build-id="buildId"
  />
  <BuildList v-else />
</template>
