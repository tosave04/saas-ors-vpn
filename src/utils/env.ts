import { config, DotenvConfigOptions } from 'dotenv';

let envLoaded = false;

export const loadEnv = (options?: DotenvConfigOptions) => {
  if (!envLoaded) {
    config(options);
    envLoaded = true;
  }
};
