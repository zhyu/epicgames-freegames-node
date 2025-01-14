import 'source-map-support/register';
import { writeFileSync } from 'fs';
import got from 'got';
import { config } from './common/config';
import L from './common/logger';

const PROJECT_NAME = 'epicgames-freegames-node';

async function checkForUpdate(): Promise<void> {
  const { COMMIT_SHA, BRANCH } = process.env;
  if (!(COMMIT_SHA && BRANCH) || config.skipVersionCheck) {
    L.debug(
      { COMMIT_SHA, BRANCH, skipVersionCheck: config.skipVersionCheck },
      'Skipping version check'
    );
    return;
  }
  L.debug({ PROJECT_NAME, BRANCH, COMMIT_SHA }, 'Performing version check');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await got.get<any>(
    `https://api.github.com/repos/claabs/${PROJECT_NAME}/commits/${BRANCH}`,
    {
      responseType: 'json',
    }
  );
  const latestSha = resp.body.sha;
  L.trace({ latestSha }, 'Response from GitHub API');
  if (COMMIT_SHA !== latestSha) {
    L.warn(
      `A newer version of ${PROJECT_NAME} is available! \`docker pull\` this image to update.`
    );
  }
}

checkForUpdate()
  .then(() => {
    const { runOnStartup, runOnce, cronSchedule, timezone } = config;

    writeFileSync(
      '/tmp/config.json',
      JSON.stringify({ runOnStartup, runOnce, cronSchedule, timezone }),
      'utf-8'
    );
  })
  .catch((err) => L.error(err));
