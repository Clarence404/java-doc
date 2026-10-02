<script setup>
import {Layout} from 'vuepress-theme-hope/client';
import HomeEditorial from '../components/home/HomeEditorial.vue';
</script>

<!-- 首页布局：保留主题的导航栏与搜索，正文替换为杂志式 Bento 目录 -->
<template>
  <Layout>
    <template #default>
      <HomeEditorial />
    </template>
  </Layout>
</template>
