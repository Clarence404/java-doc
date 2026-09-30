<script setup>
import {Layout} from 'vuepress-theme-hope/client';
import HomeAtlas from '../components/home/HomeAtlas.vue';
</script>

<!-- 首页布局：保留主题的导航栏与搜索，正文替换为知识星图 -->
<template>
  <Layout>
    <template #default>
      <HomeAtlas />
    </template>
  </Layout>
</template>
