import { $, execaNode } from 'execa-cjs';
import path from 'node:path';
const packageJsonPath = path.normalize(path.join(__dirname, '..', 'package.json'));
const rootDir = path.dirname(packageJsonPath);
const dbPath = path.join(rootDir, 'db');
const cliPath = path.join(rootDir, 'build', 'interface', 'cli', 'cli.js');

const lgCodes = [
  // basic-test-cases
  '131016', // 東京都千代田区
  '011045', // 北海道札幌市白石区 (小字に丁目が入る)

  // general-test-cases
  '033812', // 岩手県胆沢郡金ケ崎町
  '132080', // 東京都調布市
  '122157', // 千葉県旭市
  '124109', // 千葉県山武郡横芝光町
  '102083', // 群馬県渋川市
  '162019', // 富山県富山市
  '011029', // 北海道札幌市
  '202126', // 長野県大町市
  '271284', // 大阪府大阪市中央区
  '011011', // 北海道札幌市中央区
  '232114', // 愛知県豊田市
  '282197', // 兵庫県三田市
  '112143', // 埼玉県春日部市
  '442011', // 大分県大分市
  '082082', // 茨城県龍ケ崎市
  '271098', // 大阪府大阪市天王寺区
  '015857', // 北海道勇払郡安平町
  '142182', // 神奈川県綾瀬市
  '016624', // 北海道厚岸郡厚岸町
  '014346', // 北海道雨竜郡秩父別町
  '372013', // 香川県高松市
  '022039', // 青森県八戸市
  '072044', // 福島県いわき市
  '032018', // 岩手県盛岡市
  '262013', // 京都府福知山市
  '012068', // 北海道釧路市
  '013048', // 北海道石狩郡新篠津村
  '242080', // 三重県名張市
  '022063', // 青森県十和田市

  // issue #166
  '122246', // 千葉県鎌ケ谷市
  '122297', // 千葉県袖ケ浦市
  '213624', // 岐阜県不破郡関ケ原

  // issue #133
  '183229', // 福井県永平寺町
  '182052', // 福井県大野市
  '032140', // 岩手県八幡平市

  // issue #122
  '014257', // 北海道空知郡上砂川町

  '261017', // 京都府 京都市北区
  '261025', // 京都府 京都市上京区
  '261033', // 京都府 京都市左京区
  '261041', // 京都府 京都市中京区
  '261050', // 京都府 京都市東山区
  '261068', // 京都府 京都市下京区
  '261076', // 京都府 京都市南区
  '261084', // 京都府 京都市右京区
  '261092', // 京都府 京都市伏見区
  '261106', // 京都府 京都市山科区
  '261114', // 京都府 京都市西京区
  
  '011011', // 北海道札幌市中央区
  '011029', // 北海道札幌市北区
  '011053', // 北海道札幌市豊平区
  '011061', // 北海道札幌市南区
  '011070', // 北海道札幌市西区
  '011096', // 北海道札幌市手稲区

  '122271', // 千葉県安浦市
  '131032', // 東京都港区
  '131130', // 東京都渋谷区
  '401323', // 福岡県福岡市博多区
  '231061', // 愛知県名古屋市中区
];

(async () => {
  await $({ stdout: 'inherit', stderr: 'inherit' })`npm run build`;
  // await $({ stdout: 'inherit', stderr: 'inherit' })`npx rimraf ${dbPath}/database`;
  // await $({ stdout: 'inherit', stderr: 'inherit' })`npx rimraf ${dbPath}/cache`;
  await $({ stdout: 'inherit', stderr: 'inherit' })`node ${cliPath} download -c ${lgCodes.join(' ')} -d ${dbPath}`;
  
  const controller = new AbortController();

  try {
    const serverTaskPromise = $({
      stdout: 'inherit',
      stderr: 'inherit',
      cancelSignal: controller.signal,
      detached: true,
      env: {
        USE_HTTP: 'true',
      }
    })`node ${cliPath} serve -d ${dbPath}`;

    await $({ stdout: 'inherit', stderr: 'inherit' })`npx jest --maxWorker=25% --config ${rootDir}/jest.e2e.config.js`
    controller.abort();

    await serverTaskPromise;

  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    throw error;
  }
  
})();
