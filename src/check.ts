import { api } from "./api.js";

console.log(await api.getNetwork());
console.log(await api.whoami());
