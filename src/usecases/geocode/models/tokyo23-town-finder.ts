import { DASH } from "@config/constant-values";
import { makeDirIfNotExists } from "@domain/services/make-dir-if-not-exists";
import { getPackageInfo } from "@domain/services/package/get-package-info";
import { RegExpEx } from "@domain/services/reg-exp-ex";
import { TownMatchingInfo } from "@domain/types/geocode/town-info";
import fs from 'node:fs';
import path from 'node:path';
import { deserialize, serialize } from "node:v8";
import { jisKanji } from '../services/jis-kanji';
import { kan2num } from '../services/kan2num';
import { toHiragana } from '../services/to-hiragana';
import { AbrGeocoderDiContainer } from './abr-geocoder-di-container';
import { TrieAddressFinder } from "./trie/trie-finder";

export class Tokyo23TownTrieFinder extends TrieAddressFinder<TownMatchingInfo> {

  private constructor() {
    super();
  }

  private static normalizeStr(address: string): string {
    // 片仮名を平仮名に変換する
    address = toHiragana(address);

    // 漢数字を半角数字に変換する
    address = kan2num(address);
    
    // JIS 第2水準 => 第1水準 及び 旧字体 => 新字体
    address = jisKanji(address);

    // 〇〇番地[〇〇番ー〇〇号]、の [〇〇番ー〇〇号] だけを取る
    address = address?.replaceAll(RegExpEx.create(`(\\d+)${DASH}?[番号町地丁目]+の?`, 'g'), `$1${DASH}`);

    return address;
  }

  static readonly create = async (diContainer: AbrGeocoderDiContainer) => {
    const { version } = getPackageInfo();
    const cacheDir = path.join(diContainer.cacheDir, version);
    makeDirIfNotExists(cacheDir);

    const tree = new Tokyo23TownTrieFinder();
    const cacheFilePath = path.join(cacheDir, 'tokyo23-town.v8');
    const isExist = fs.existsSync(cacheFilePath);
    if (isExist) {
      // キャッシュがあれば、キャッシュから読み込む
      const encoded = await fs.promises.readFile(cacheFilePath);
      const treeNodes = deserialize(encoded);
      tree.root = treeNodes;
      return tree;
    }

    // キャッシュがなければ、Databaseからデータをロードして読み込む
    // キャッシュファイルも作成する
    const commonDb = await diContainer.database.openCommonDb();
    const rows = await commonDb.getTokyo23Towns();

    for (const row of rows) {
      tree.append({
        key: Tokyo23TownTrieFinder.normalizeStr(row.key),
        value: row,
      });
    }

    // キャッシュファイルに保存
    const encoded = serialize(tree.root);
    await fs.promises.writeFile(cacheFilePath, encoded);

    return tree;
  }
}
