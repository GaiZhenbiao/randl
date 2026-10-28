import {writable} from 'svelte/store';
import type {Message} from './i18n';
export type ProjectConfirmation = {
  session:string; id:string; token:string;
  project:{id:string;name:string}; summary:any;
  entered:string; submitting:''|'confirm'|'decline'; error:Message;
};
export const pendingProjectConfirmation=writable<ProjectConfirmation|null>(null);
