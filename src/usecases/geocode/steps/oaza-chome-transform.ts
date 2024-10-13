/*!
 * MIT License
 *
 * Copyright (c) 2024 デジタル庁
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { DASH, DEFAULT_FUZZY_CHAR } from '@config/constant-values';
import { RegExpEx } from '@domain/services/reg-exp-ex';
import { MatchLevel } from '@domain/types/geocode/match-level';
import { CharNode } from "@usecases/geocode/models/trie/char-node";
import { Transform, TransformCallback } from 'node:stream';
import { OazaChoTrieFinder } from '../models/oaza-cho-trie-finder';
import { Query } from '../models/query';
import { QuerySet } from '../models/query-set';
import { trimDashAndSpace } from '../services/trim-dash-and-space';

export class OazaChomeTransform extends Transform {

  constructor(
    private readonly trie: OazaChoTrieFinder,
  ) {
    super({
      objectMode: true,
    });
  }
  private createWhereCondition(query: Query): Partial<{
    pref_key: number;
    city_key: number;
    town_key: number;
  }> | undefined {
    const conditions: Partial<{
      pref_key: number;
      city_key: number;
      town_key: number;
    }> = {};

    let anyHit = false;
    if (query.pref_key) {
      anyHit = true;
      conditions.pref_key = query.pref_key;
    }
    if (query.city_key) {
      anyHit = true;
      conditions.city_key = query.city_key;
    }
    if (query.oaza_cho) {
      anyHit = true;
      conditions.town_key = query.town_key;
    }
    if (!anyHit) {
      return undefined;
    }
    return conditions;
  }

  async _transform(
    queries: QuerySet,
    _: BufferEncoding,
    callback: TransformCallback,
  ) {
    // ------------------------
    // 大字・丁目・小字で当たるものがあるか
    // ------------------------
    const results = new QuerySet();
    for await (const query of queries.values()) {
      if (query.match_level.num >= MatchLevel.MACHIAZA.num) {
        // 大字が既に判明している場合はスキップ
        results.add(query);
        continue;
      }
      if (!query.tempAddress) {
        // 探索する文字がなければスキップ
        results.add(query);
        continue;
      }
      if (query.koaza_aka_code === 2) {
        // 通り名が当たっている場合はスキップ
        results.add(query);
        continue;
      }
      
      const bearingWord = query.tempAddress.match(RegExpEx.create('(上る|下る|東入|西入)'));
      if (bearingWord) {
        // 京都通り名の特徴がある場合はスキップ
        results.add(query);
        continue;
      }

      // ------------------------------------
      // Queryの情報を使って、条件式を作成
      // ------------------------------------
      const where = this.createWhereCondition(query);
      
      // ------------------------------------
      // トライ木を使って探索
      // ------------------------------------
      const copiedQuery = this.normalizeQuery(query);
      if (!copiedQuery.tempAddress) {
        results.add(copiedQuery);
        continue;
      }
      const target = trimDashAndSpace(query.tempAddress);
      if (!target) {
        results.add(copiedQuery);
        continue;
      }
      // 小字に数字が含まれていて、それが番地にヒットする場合がある。
      // この場合は、マッチしすぎているので、中間結果を返す必要がある。
      // partialMatches = true にすると、中間結果を含めて返す。
      //
      // target = 末広町184
      // expected = 末広町
      // wrong_matched_result = 末広町18字
      const findResults = this.trie.find({
        target,
        partialMatches: true,

        // マッチしなかったときに、unmatchAttemptsに入っている文字列を試す。
        // 「〇〇町」の「町」が省略された入力の場合を想定
        extraChallenges: ['町'],
        fuzzy: DEFAULT_FUZZY_CHAR,
      }) || [];
      
      const filteredResult = findResults?.filter(result => {
        if (!where) {
          return true;
        }

        let matched = true;
        if (where.pref_key) {
          matched = result.info?.pref_key === where.pref_key;
        }
        if (matched && where.city_key) {
          matched = result.info?.city_key === where.city_key;
        }
        if (matched && where.town_key) {
          matched = result.info?.town_key === where.town_key;
        }
        return matched;
      });

      // 複数都道府県にヒットする可能性があるので、全て試す
      let anyHit = false;
      let anyAmbiguous = false;
      filteredResult?.forEach(findResult => {
        // city_key が判別している場合で
        // city_key が異なる場合はスキップ
        if ((copiedQuery.city_key !== undefined) &&
          (copiedQuery.city_key !== findResult.info?.city_key)) {
          return;
        }
        anyAmbiguous = anyAmbiguous || findResult.ambiguous;

        const info = findResult.info!;
        anyHit = true;
        const params: Record<string, CharNode | number | string | MatchLevel | null> = {
          pref_key: info.pref_key,
          city_key: info.city_key,
          town_key: info.town_key,
          lg_code: info.lg_code,
          pref: info.pref,
          city: info.city,
          oaza_cho: info.oaza_cho,
          chome: info.chome,
          koaza: info.koaza,
          machiaza_id: info.machiaza_id,
          rsdt_addr_flg: info.rsdt_addr_flg,
          tempAddress: findResult.unmatched,
          match_level: info.match_level,
          matchedCnt: copiedQuery.matchedCnt + findResult.depth,
          ambiguousCnt: copiedQuery.ambiguousCnt + (findResult.ambiguous ? 1 : 0), 
        };
        if (info.rep_lat && info.rep_lon) {
          params.rep_lat = info.rep_lat;
          params.rep_lon = info.rep_lon;
          params.coordinate_level = info.coordinate_level;
        }
        const copied = copiedQuery.copy(params);
        results.add(copied);
      });

      if (!anyHit || anyAmbiguous) {
        results.add(query);
      }
    }
    callback(null, results);
  }

  
  private normalizeQuery(query: Query): Query {

    let address: CharNode | undefined = query.tempAddress?.trimWith(DASH);

    if (query.city === '福井市' && query.pref === '福井県') {
      address = address?.replaceAll(RegExpEx.create('^99', 'g'), 'つくも');
    }
    if (query.city === '海田町' && query.pref === '広島県' && query.county === '安芸郡') {
      address = address?.replaceAll(RegExpEx.create('^(南)?99町', 'g'), '$1つくも町');
    }

    return query.copy({
      tempAddress: address,
    });
  }
}
