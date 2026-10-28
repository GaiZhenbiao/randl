import { mount } from 'svelte';
import App from './App.svelte';
import { initialiseLanguage } from './i18n';
import 'carbon-components-svelte/css/all.css';
import './style.css';
await initialiseLanguage();
mount(App, { target: document.getElementById('app')! });
