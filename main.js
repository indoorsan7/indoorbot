import { Client, Collection, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ActivityType } from 'discord.js';
import http from 'http';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
// DISCORD_CLIENT_SECRET は現在使用されていないため、削除しました。

// Webサーバーの起動（Renderのヘルスチェック用）
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is alive!');
});

const port = process.env.PORT || 8000;
server.listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

// Discordクライアントの初期化
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
});

client.commands = new Collection();

// Canvas環境で提供されるアプリIDを優先、なければデフォルト値を使用
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-discord-incoin-app';

// Firebase初期化変数
let firebaseApp;
let db;
let auth;
let firebaseAuthUid = 'anonymous'; // Firebase Auth UID

// === いんコインデータ（メモリにキャッシュされ、登録済みユーザーはFirestoreと同期されます） ===
const userDataCache = new Map(); // key: discordUserId, value: { balances: number, bankBalances: number, ... }
const companyDataCache = new Map(); // 会社データキャッシュ

// ユーザーデータのデフォルト構造
const defaultUserData = {
    balances: 0,
    bankBalances: 0,
    creditPoints: 5,
    lastWorkTime: 0,
    lastRobTime: 0,
    lastInterestTime: 0,
    punishedForNegativeCredit: false,
    job: '無職', // 初期職業は無職
    isRegistered: false, // 新しいフラグ：登録済みかどうか (trueの場合のみFirestoreに保存)
    subscribers: 0, // Youtuber用
    companyId: null, // 所属する会社のID
    username: '不明なユーザー' // デフォルトのユーザー名
};

const defaultCompanyData = {
    name: null,
    ownerId: null,
    dailySalary: 0,
    budget: 0,
    autoDeposit: false,
    members: [], // [{ id: userId, username: "username" }]
    lastPayoutTime: 0 // 最終支払い時刻
};


// 職業ごとの獲得額設定 (ハードコード)
const jobSettings = new Map([
    ["無職", { min: 1000, max: 1500 }], // 無職を追加 (デフォルトの獲得額)
    ["Youtuber", { minMultiplier: 500, maxMultiplier: 1250 }], // Youtuberは特殊計算なのでmin/maxMultiplier
    ["社長", { minBase: 400000, maxBase: 650000, memberBonus: 30000 }], // 社長職の追加
    ["お肉屋", { min: 2000, max: 2500 }],
    ["魚屋", { min: 4500, max: 7500 }],
    ["レストラン店主", { min: 8000, max: 10000 }],
    ["カフェ店主", { min: 12000, max: 13000 }],
    ["タクシー運転手", { min: 17500, max: 23000 }],
    ["バス運転手", { min: 25000, max: 30000 }],
    ["ホテル支配人", { min: 45000, max: 60000 }],
    ["科学技術者", { min: 70000, max: 80000 }],
    ["公認会計士", { min: 85000, max: 100000 }],
    ["歯科医師", { min: 115000, max: 130000 }],
    ["医者", { min: 140000, max: 175000 }],
    ["航空機操縦士", { min: 150000, max: 210000 }]
]);


// 職業ごとの転職費用 (ハードコード)
const jobChangeCosts = new Map([
    ["無職", 0], // 無職への転職費用は0
    ["Youtuber", 3000],
    ["お肉屋", 100000],
    ["魚屋", 750000],
    ["レストラン店主", 1000000],
    ["カフェ店主", 1700000],
    ["タクシー運転手", 3000000],
    ["バス運転手", 3500000],
    ["ホテル支配人", 5000000],
    ["科学技術者", 6500000],
    ["公認会計士", 7500000],
    ["歯科医師", 8000000],
    ["医者", 11000000],
    ["航空機操縦士", 16500000]
]);

const authChallenges = new Map(); // 認証チャレンジ用（一時データ）
const ticketPanels = new Map();   // チケットパネル設定用（一時データ）

// Firestoreドキュメントへの参照を取得するヘルパー関数
const getUserDocRef = (discordUserId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. User data operations might not persist.');
        return null;
    }
    // Added check for empty userId to prevent doc() error
    if (!discordUserId || discordUserId === '') {
        console.warn(`Attempted to get user doc ref with invalid userId: '${discordUserId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/discord_incoin_data`), discordUserId);
};

const getCompanyDocRef = (companyId) => {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Company data operations might not persist.');
        return null;
    }
    // Explicitly check for empty string companyId to prevent doc() error
    if (!companyId || companyId === '') {
        console.warn(`Attempted to get company doc ref with invalid companyId: '${companyId}'. Returning null.`);
        return null;
    }
    return doc(collection(db, `artifacts/${appId}/public/data/companies`), companyId);
};

/**
 * ユーザーの全データをメモリキャッシュから取得、またはFirestoreからロードします。
 * 初回アクセス時やデータが存在しない場合はデフォルト値を設定してFirestoreに保存します。
 * @param {string} discordUserId - DiscordユーザーID
 * @returns {Promise<Object>} - ユーザーのデータオブジェクト
 */
async function getUserData(discordUserId) {
    if (userDataCache.has(discordUserId)) {
        return userDataCache.get(discordUserId);
    }

    const docRef = getUserDocRef(discordUserId);
    if (!docRef) { // dbが準備できていない、またはdiscordUserIdが無効な場合
        const data = { ...defaultUserData };
        userDataCache.set(discordUserId, data);
        return data;
    }

    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            // FirestoreからロードしたデータにisRegisteredがなければtrueとみなす（既存ユーザー対応）
            if (data.isRegistered === undefined) {
                data.isRegistered = true;
            }
            // 欠けているデフォルトフィールドを補完
            for (const key in defaultUserData) {
                if (data[key] === undefined) {
                    data[key] = defaultUserData[key];
                }
            }
            userDataCache.set(discordUserId, data);
            return data;
        } else {
            // Firestoreにデータがない場合、デフォルトの未登録データを返す
            const data = { ...defaultUserData }; // スプレッド構文でコピーを作成
            userDataCache.set(discordUserId, data);
            return data; // Firestoreには保存しない
        }
    } catch (error) {
        console.error(`Error loading user data for ${discordUserId}:`, error);
        // ロード失敗時もデフォルトの未登録データを返す
        const data = { ...defaultUserData };
        userDataCache.set(discordUserId, data);
        return data;
    }
}

/**
 * ユーザーのデータをメモリキャッシュを更新し、登録済みユーザーの場合のみFirestoreに保存します。
 * @param {string} discordUserId - DiscordユーザーID
 * @param {Object} userDataToSave - 更新するデータオブジェクト
 */
async function saveUserDataToFirestore(discordUserId, userDataToSave) {
    // isRegisteredが明示的にfalseでない限りtrueとして扱う
    if (userDataToSave.isRegistered === undefined) {
        userDataToSave.isRegistered = true;
    }

    const docRef = getUserDocRef(discordUserId);
    if (!docRef) { // dbが準備できていない、またはdiscordUserIdが無効な場合
        console.warn(`Cannot save user data for ${discordUserId}. Firestore reference not available or invalid userId.`);
        return;
    }

    try {
        await setDoc(docRef, userDataToSave, { merge: true }); // merge: trueで他のフィールドを上書きしない
        userDataCache.set(discordUserId, userDataToSave); // キャッシュも更新
    } catch (error) {
        console.error(`Error saving user data for ${discordUserId}:`, error);
    }
}


/**
 * ユーザーのデータをメモリキャッシュを更新し、登録済みユーザーの場合のみFirestoreに保存します。
 * @param {string} discordUserId - DiscordユーザーID
 * @param {string} key - 更新するデータオブジェクトのキー (例: 'balances')
 * @param {*} value - 更新する値
 */
async function updateUserDataField(discordUserId, key, value) {
    // まず最新のデータを取得 (キャッシュにあればそれ、なければFirestoreからロード)
    const data = await getUserData(discordUserId); // これでキャッシュには入る

    // 値を更新
    data[key] = value;

    // キャッシュを更新 (getUserDataが既にやっているが、念のため)
    userDataCache.set(discordUserId, data);

    // ユーザーが登録済みの場合のみFirestoreに保存
    if (data.isRegistered) {
        const docRef = getUserDocRef(discordUserId);
        if (!docRef) {
            console.warn(`Cannot update user data field '${key}' for ${discordUserId}. Firestore reference not available or invalid userId.`);
            return;
        }
        try {
            await setDoc(docRef, data, { merge: true }); // merge: trueで他のフィールドを上書きしない
            // console.log(`User data field '${key}' saved for ${discordUserId}.`); // デバッグ用ログ
        } catch (error) {
            console.error(`Error saving user data for ${discordUserId} (field: ${key}):`, error);
        }
    }
}

// 既存のget/add関数を、getUserDataとupdateUserDataFieldを使用するように書き換え
async function getCoins(userId) {
    const data = await getUserData(userId);
    return data.balances;
}

async function addCoins(userId, amount) {
    const data = await getUserData(userId);
    const newCoins = data.balances + amount;
    // 残高がマイナスにならないようにする
    if (newCoins < 0) {
        // console.log(`Attempted to set negative balance for ${userId}. Setting to 0.`);
        // return newCoins; // マイナスになってもそのまま更新する場合
    }
    await updateUserDataField(userId, 'balances', Math.max(0, newCoins)); // 0未満にならないように調整
    return Math.max(0, newCoins);
}

async function getBankCoins(userId) {
    const data = await getUserData(userId);
    return data.bankBalances;
}

async function addBankCoins(userId, amount) {
    const data = await getUserData(userId);
    const newBankCoins = data.bankBalances + amount;
    await updateUserDataField(userId, 'bankBalances', Math.max(0, newBankCoins)); // 0未満にならないように調整
    return Math.max(0, newBankCoins);
}

async function getCreditPoints(userId) {
    const data = await getUserData(userId);
    return data.creditPoints;
}

async function addCreditPoints(userId, amount) {
    const data = await getUserData(userId);
    const oldCreditPoints = data.creditPoints;
    const newCreditPoints = oldCreditPoints + amount;
    await updateUserDataField(userId, 'creditPoints', newCreditPoints);
    // 信用ポイントが0以上に戻った場合、罰金フラグをリセット
    if (oldCreditPoints < 0 && newCreditPoints >= 0) {
        await setUserPunishedForNegativeCredit(userId, false);
        console.log(`User ${userId}: punishedForNegativeCredit reset to false as creditPoints are now ${newCreditPoints}.`);
    }
    return newCreditPoints;
}

// ユーザーの職業を取得
async function getUserJob(userId) {
    const data = await getUserData(userId);
    return data.job;
}

// ユーザーの職業を設定
async function setUserJob(userId, jobName) {
    await updateUserDataField(userId, 'job', jobName);
}

// ユーザーの最終仕事時間を取得
async function getUserLastWorkTime(userId) {
    const data = await getUserData(userId);
    return data.lastWorkTime;
}

// ユーザーの最終仕事時間を設定
async function setUserLastWorkTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastWorkTime', timestamp);
}

// ユーザーの最終強盗時間を取得
async function getUserLastRobTime(userId) {
    const data = await getUserData(userId);
    return data.lastRobTime;
}

// ユーザーの最終強盗時間を設定
async function setUserLastRobTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastRobTime', timestamp);
}

// ユーザーの最終利子計算時間を取得
async function getUserLastInterestTime(userId) {
    const data = await getUserData(userId);
    return data.lastInterestTime;
}

// ユーザーの最終利子計算時間を設定
async function setUserLastInterestTime(userId, timestamp) {
    await updateUserDataField(userId, 'lastInterestTime', timestamp);
}

// ユーザーが負の信用ポイントで罰金済みかを取得
async function getUserPunishedForNegativeCredit(userId) {
    const data = await getUserData(userId);
    return data.punishedForNegativeCredit;
}

// ユーザーが負の信用ポイントで罰金済みかを設定
async function setUserPunishedForNegativeCredit(userId, punished) {
    await updateUserDataField(userId, 'punishedForNegativeCredit', punished);
}

async function getSubscribers(userId) {
    const data = await getUserData(userId);
    return data.subscribers;
}

async function setSubscribers(userId, amount) {
    await updateUserDataField(userId, 'subscribers', amount);
}

// Company functions
async function getCompanyData(companyId) {
    if (companyDataCache.has(companyId)) {
        return companyDataCache.get(companyId);
    }
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) { // dbが準備できていない、またはcompanyIdが無効な場合
        const data = { ...defaultCompanyData };
        companyDataCache.set(companyId, data);
        return data;
    }
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            // 欠けているデフォルトフィールドを補完
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            companyDataCache.set(companyId, data);
            return data;
        } else {
            const data = { ...defaultCompanyData };
            companyDataCache.set(companyId, data);
            return data;
        }
    } catch (error) {
        console.error(`Error loading company data for ${companyId}:`, error);
        const data = { ...defaultCompanyData };
        companyDataCache.set(companyId, data);
        return data;
    }
}

async function saveCompanyDataToFirestore(companyId, companyDataToSave) {
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) { // dbが準備できていない、またはcompanyIdが無効な場合
        console.warn(`Cannot save company data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await setDoc(docRef, companyDataToSave, { merge: true });
        companyDataCache.set(companyId, companyDataToSave); // キャッシュも更新
    } catch (error) {
        console.error(`Error saving company data for ${companyId}:`, error);
    }
}

async function updateCompanyDataField(companyId, key, value) {
    const data = await getCompanyData(companyId);
    data[key] = value;
    companyDataCache.set(companyId, data);
    await saveCompanyDataToFirestore(companyId, data);
}

async function deleteCompanyFromFirestore(companyId) {
    const docRef = getCompanyDocRef(companyId);
    if (!docRef) { // dbが準備できていない、またはcompanyIdが無効な場合
        console.warn(`Cannot delete company data for ${companyId}. Firestore reference not available or invalid companyId.`);
        return;
    }
    try {
        await deleteDoc(docRef);
        companyDataCache.delete(companyId);
    } catch (error) {
        console.error(`Error deleting company data for ${companyId}:`, error);
    }
}

async function getAllCompanies() {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Cannot get all companies.');
        return [];
    }
    const companiesCollectionRef = collection(db, `artifacts/${appId}/public/data/companies`);
    const companies = [];
    try {
        const querySnapshot = await getDocs(companiesCollectionRef);
        querySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            // デフォルト値が欠けている場合を考慮
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            companyDataCache.set(companyId, data);
            companies.push({ id: companyId, ...data });
        });
        return companies;
    } catch (error) {
        console.error("Error fetching all companies:", error);
        return [];
    }
}

/**
 * Firestoreから全てのユーザーデータと会社データを同期し、キャッシュを更新します。
 * 存在しない会社IDを持つユーザーのデータをクリーンアップします。
 * @returns {object} - 同期されたユーザー数と会社数を返します。
 */
async function syncAllDataFromFirestore() {
    console.log("Syncing all data from Firestore...");
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready. Cannot sync all data.');
        return { users: 0, companies: 0 };
    }

    // まずキャッシュをクリア
    userDataCache.clear();
    companyDataCache.clear();

    let loadedUsersCount = 0;
    let loadedCompaniesCount = 0;

    try {
        // 全ての会社データを読み込み
        const companiesCollectionRef = collection(db, `artifacts/${appId}/public/data/companies`);
        const companiesQuerySnapshot = await getDocs(companiesCollectionRef);
        companiesQuerySnapshot.forEach(docSnap => {
            const companyId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultCompanyData) {
                if (data[key] === undefined) {
                    data[key] = defaultCompanyData[key];
                }
            }
            companyDataCache.set(companyId, data);
            loadedCompaniesCount++;
        });
        console.log(`Successfully loaded ${loadedCompaniesCount} company data entries from Firestore.`);

        // 全てのユーザーデータを読み込み
        const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/discord_incoin_data`);
        const usersQuerySnapshot = await getDocs(usersCollectionRef);
        for (const docSnap of usersQuerySnapshot.docs) {
            const userId = docSnap.id;
            const data = docSnap.data();
            for (const key in defaultUserData) {
                if (data[key] === undefined) {
                    data[key] = defaultUserData[key];
                }
            }
            
            // 存在しないcompanyIdのクリーンアップ
            if (data.companyId && !companyDataCache.has(data.companyId)) {
                console.warn(`User ${userId} has companyId ${data.companyId} but company does not exist. Cleaning up.`);
                data.companyId = null;
                data.job = '無職'; // 会社がないので無職に戻す
                await saveUserDataToFirestore(userId, data); // Firestoreも更新
                // userDataCache.set(userId, data); // saveUserDataToFirestoreがキャッシュも更新
            }
            userDataCache.set(userId, data); // クリーンアップ後のデータまたは元のデータをキャッシュに設定
            loadedUsersCount++;
        }
        console.log(`Successfully loaded and cleaned up ${loadedUsersCount} user data entries from Firestore.`);

        return { users: loadedUsersCount, companies: loadedCompaniesCount };
    } catch (error) {
        console.error("Error syncing all data from Firestore:", error);
        return { users: 0, companies: 0 };
    }
}


// 会社メンバーへの日給支払い処理と維持費の引き落とし
async function applyDailyCompanyPayouts() {
    console.log("Applying daily company payouts...");
    const companies = await getAllCompanies(); // 最新の会社データを取得

    for (const company of companies) {
        const now = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1日

        // 最終支払い時刻が設定されていない、または1日以上経過している場合
        if (now - company.lastPayoutTime >= ONE_DAY_MS) {
            const dailySalary = company.dailySalary;
            const members = company.members || [];
            const ownerId = company.ownerId;
            const companyName = company.name;

            // 維持費を計算: 日給 × 人数 + 300,000
            const maintenanceFee = (dailySalary * members.length) + 300000;
            const totalPayoutNeeded = (dailySalary * members.length); // 純粋な日給の合計

            console.log(`Company ${companyName} (${company.id}): Daily salary: ${dailySalary}, Members: ${members.length}, Maintenance Fee: ${maintenanceFee}, Current Budget: ${company.budget}`);

            if (company.budget < maintenanceFee + totalPayoutNeeded) { // 維持費と日給支払いの両方で足りない場合
                console.warn(`Company ${companyName} (${company.id}) budget (${company.budget}) is insufficient for maintenance fee (${maintenanceFee}) and payout (${totalPayoutNeeded}). Deleting company.`);

                // 社長に予算不足と会社削除をDM通知
                const owner = await client.users.fetch(ownerId).catch(() => null);
                if (owner) {
                    const embed = new EmbedBuilder()
                        .setTitle('会社削除通知: 予算不足')
                        .setColor('#FF0000')
                        .setDescription(`あなたの会社「${companyName}」は、維持費と日給支払いに必要な予算が不足しているため、削除されました。
必要な維持費: ${maintenanceFee.toLocaleString()} いんコイン
必要な日給合計: ${totalPayoutNeeded.toLocaleString()} いんコイン
現在の予算: ${company.budget.toLocaleString()} いんコイン

社員は自動的に会社から脱退し、「無職」に戻りました。`)
                        .setTimestamp();
                    try {
                        await owner.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.error(`Failed to send company deletion DM to owner ${ownerId}:`, dmError);
                    }
                }

                // 全メンバーのcompanyIdをnullにリセットし、職業を「無職」に戻す
                for (const member of members) {
                    await updateUserDataField(member.id, 'companyId', null);
                    await setUserJob(member.id, "無職"); // 社長も含め全員無職に戻す
                    // メンバーにも会社が解散したことをDMで通知
                    const memberUser = await client.users.fetch(member.id).catch(() => null);
                    if (memberUser && member.id !== ownerId) { // 社長には既にDM済みのため重複を避ける
                        const memberEmbed = new EmbedBuilder()
                            .setTitle('会社解散通知')
                            .setColor('#FF0000')
                            .setDescription(`あなたが所属していた会社「${companyName}」は、予算不足のため解散しました。
あなたの職業は「無職」に戻りました。`)
                            .setTimestamp();
                        try {
                            await memberUser.send({ embeds: [memberEmbed] });
                        } catch (dmError) {
                            console.error(`Failed to send dissolution DM to member ${member.id}:`, dmError);
                        }
                    }
                }
                await deleteCompanyFromFirestore(company.id); // 会社データを削除
                console.log(`Company ${companyName} (${company.id}) was deleted due to insufficient budget.`);
                continue; // 次の会社へ
            }

            // 予算から維持費を差し引く
            await updateCompanyDataField(company.id, 'budget', company.budget - maintenanceFee);
            console.log(`Company ${companyName} (${company.id}): Deducted maintenance fee ${maintenanceFee}. New budget: ${company.budget - maintenanceFee}`);

            // 各メンバーに日給を付与
            for (const member of members) {
                await addCoins(member.id, dailySalary);
                // メンバーに日給支払いをDM通知
                const memberUser = await client.users.fetch(member.id).catch(() => null);
                if (memberUser) {
                    const embed = new EmbedBuilder()
                        .setTitle('日給支払い通知')
                        .setColor('#00FF00')
                        .setDescription(`会社「${companyName}」から日給として **${dailySalary.toLocaleString()}** いんコインが支払われました。
現在の所持金: ${(await getUserData(member.id)).balances.toLocaleString()} いんコイン`)
                        .setTimestamp();
                    try {
                        await memberUser.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.error(`Failed to send daily salary DM to member ${member.id}:`, dmError);
                    }
                }
            }
            console.log(`Company ${companyName} (${company.id}) paid ${totalPayoutNeeded} to its members.`);
            await saveCompanyDataToFirestore(company.id, { ...company, lastPayoutTime: now }); // 成功しても失敗しても時間を更新
        }
    }
}


// 毎日午後9時に実行されるように設定 (JST)
setInterval(async () => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // 日本時間の午後9時 (21時00分) に実行
    if (currentHour === 21 && currentMinute === 0) {
        if (client.isReady() && GUILD_ID && db && firebaseAuthUid !== 'anonymous') {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                console.log('Applying daily company payouts...');
                await applyDailyCompanyPayouts();
            }
        }
    }
    // 毎週の更新もここで定期実行
    if (currentHour === 21 && currentMinute === 0 && now.getDay() === 4) { // 木曜日の午後9時 (0=日, 1=月, ..., 4=木)
        if (client.isReady() && GUILD_ID && db && firebaseAuthUid !== 'anonymous') {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                console.log('Applying weekly updates...');
                await applyWeeklyUpdates(guild);
            }
        }
    }
}, 60 * 1000); // 1分ごとにチェック


async function applyWeeklyUpdates(guild) {
    if (!db || firebaseAuthUid === 'anonymous') {
        console.warn('Firestore instance or authenticated UID is not ready for weekly updates. Skipping.');
        return;
    }
    const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/discord_incoin_data`);
    try {
        const querySnapshot = await getDocs(usersCollectionRef);
        for (const docSnapshot of querySnapshot.docs) {
            const userId = docSnapshot.id;
            const userData = docSnapshot.data();
            
            // 欠けているデフォルトフィールドを補完
            for (const key in defaultUserData) {
                if (userData[key] === undefined) {
                    userData[key] = defaultUserData[key];
                }
            }
            userDataCache.set(userId, userData); // キャッシュを最新の状態に保つ

            if (userData.isRegistered) {
                const lastInterestTime = userData.lastInterestTime || 0;
                const now = Date.now();
                const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
                if (now - lastInterestTime >= ONE_WEEK_MS) {
                    const creditPoints = userData.creditPoints;
                    let bankCoins = userData.bankBalances;
                    let updated = false;
                    if (creditPoints < 0) {
                        const deductionAmount = Math.floor(bankCoins * 0.10);
                        if (deductionAmount > 0) {
                            await addBankCoins(userId, -deductionAmount);
                            console.log(`User ${userId}: Deducted ${deductionAmount} (10%) from bank due to negative credit. New bank balance: ${await getBankCoins(userId)}`);
                            updated = true;
                        }
                        await addCreditPoints(userId, -1);
                        console.log(`User ${userId}: Credit points decreased to ${await getCreditPoints(userId)} due to negative credit.`);
                        updated = true;
                    } else {
                        const interestAmount = Math.floor(bankCoins * 0.03);
                        if (interestAmount > 0) {
                            await addBankCoins(userId, interestAmount);
                            console.log(`User ${userId}: Applied ${interestAmount} interest. New bank balance: ${await getBankCoins(userId)}`);
                            updated = true;
                        }
                    }
                    if (updated) {
                        await setUserLastInterestTime(userId, now);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error applying weekly updates from Firestore:", error);
    }
}

const registerCommand = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('いんコインシステムに登録します。登録しないとデータは保存されません。'),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const userData = await getUserData(userId); // 最新のデータを取得（in-memory or from Firestore）

        if (userData.isRegistered) {
            return interaction.editReply({ content: 'あなたは既にいんコインシステムに登録済みです。' });
        }

        // ユーザーデータをFirestoreに保存
        const docRef = getUserDocRef(userId);
        if (!docRef) { // dbが準備できていない、またはdiscordUserIdが無効な場合
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        try {
            // ユーザー名を保存するフィールドを追加
            const dataToSave = { ...userData, isRegistered: true, username: interaction.user.username }; 
            await setDoc(docRef, dataToSave);
            userDataCache.set(userId, dataToSave); // キャッシュも更新

            await interaction.editReply({ content: 'いんコインシステムへの登録が完了しました！これであなたのデータは自動的に保存されます。' });
        } catch (error) {
            console.error(`Error registering user ${userId}:`, error);
            await interaction.editReply({ content: '登録中にエラーが発生しました。もう一度お試しください。' });
        }
    },
};
client.commands.set(registerCommand.data.name, registerCommand);


const gamblingCommand = {
    data: new SlashCommandBuilder()
        .setName('gambling')
        .setDescription('いんコインを賭けてギャンブルをします。')
        .addIntegerOption(option => // addStringOptionからaddIntegerOptionに戻しました
            option.setName('amount')
                .setDescription('賭けるいんコインの金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const creditPoints = await getCreditPoints(userId); // awaitを追加

        if (creditPoints < 0) {
            return interaction.editReply({ content: '信用ポイントが負のため、ギャンブルはできません。' });
        }

        const betAmount = interaction.options.getInteger('amount'); // getIntegerを使用

        const currentCoins = await getCoins(userId); // awaitを追加

        if (currentCoins < betAmount) {
            return interaction.editReply({ content: `いんコインが足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
        }
        if (betAmount === 0) { // allオプション削除に伴い、0賭け防止のチェックを削除、setMinValue(1)で対応
            return interaction.editReply({ content: '賭け金が0いんコインではギャンブルできません。' });
        }

        await addCoins(userId, -betAmount); // awaitを追加

        const multiplier = Math.random() * 2.35 + 0.005; // 以前の賭け率に戻す
        let winAmount = Math.floor(betAmount * multiplier);
        
        const userJob = await getUserJob(userId);
        if (userJob === "Youtuber") {
            const jobSettingsForYoutuber = jobSettings.get("Youtuber");
            // Youtuberの獲得上限はギャンブルには適用しないため、capのチェックを削除
            // Youtuberはギャンブルの計算に影響しないため、このブロックは不要
        } else if (userJob === "社長") {
             const jobSettingsForPresident = jobSettings.get("社長");
             // 社長の仕事はギャンブルには影響しないので、ここは特殊処理なし
        }

        const newCoins = await addCoins(userId, winAmount); // awaitを追加

        const embed = new EmbedBuilder()
            .setTitle('いんコインギャンブル結果')
            .addFields(
                { name: '賭け金', value: `${betAmount.toLocaleString()} いんコイン`, inline: true },
                { name: '倍率', value: `${multiplier.toFixed(2)} 倍`, inline: true },
                { name: '獲得/損失', value: `${(winAmount - betAmount).toLocaleString()} いんコイン`, inline: true },
                { name: '現在の残高', value: `${newCoins.toLocaleString()} いんコイン`, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        if (multiplier > 1.0) {
            embed.setDescription(`あたり！ ${betAmount.toLocaleString()} いんコインが ${multiplier.toFixed(2)} 倍になり、${winAmount.toLocaleString()} いんコインを獲得しました！`)
                 .setColor('#00FF00');
        } else {
            embed.setDescription(`はずれ... ${betAmount.toLocaleString()} いんコインが ${multiplier.toFixed(2)} 倍になり、${winAmount.toLocaleString()} いんコインになりました。`)
                 .setColor('#FF0000');
            await addCreditPoints(userId, -1); // awaitを追加
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(gamblingCommand.data.name, gamblingCommand);

// moneyCommand の統合 (旧 moneyCommand と infoCommand の機能をまとめる)
const moneyCommand = {
    data: new SlashCommandBuilder()
        .setName('money')
        .setDescription('いんコイン関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('いんコイン関連のコマンドヘルプを表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('balance')
                .setDescription('自分または他のユーザーの所持金を表示します。')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('残高を確認したいユーザー')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('自分の現在の残高、銀行残高、信用ポイントを表示します。')),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('いんコインコマンドヘルプ')
                .setDescription('利用可能なコマンドとその説明です。')
                .setColor('ADFF2F')
                .addFields(
                    { name: '/money balance [user]', value: '自分または他のユーザーの所持金を表示します。', inline: false },
                    { name: '/money info', value: '自分の所持金、銀行残高、信用ポイントを表示します。', inline: false },
                    { name: '/deposit <amount>', value: '所持金を銀行に預けます。', inline: false },
                    { name: '/withdraw <amount>', value: '銀行から所持金を引き出します。', inline: false },
                    { name: '/work', value: '2時間に1回、いんコインを稼ぎます。信用ポイントが1増えます。', inline: false },
                    { name: '/rob <target>', value: '他のユーザーの所持金を盗みます。成功すると信用ポイントが5減り、失敗すると3減ります。', inline: false },
                    { name: '/gambling <amount>', value: 'いんコインを賭けてギャンブルをします。負けると信用ポイントが1減ります。', inline: false },
                    { name: '/give-money <amount> <user|role>', value: '他のユーザーまたはロールのメンバーにいんコインを渡します。', inline: false },
                    { name: '/company help', value: '会社関連のコマンドヘルプを表示します。', inline: false },
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [helpEmbed] });
        } else if (subcommand === 'balance') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const targetUserId = targetUser.id;
            const targetUserCoins = await getCoins(targetUserId); // awaitを追加

            const embed = new EmbedBuilder()
                .setTitle('いんコイン残高')
                .setColor('#FFFF00')
                .setDescription(`${targetUser.username} さんの現在のいんコイン残高は **${targetUserCoins.toLocaleString()} いんコイン** です。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'info') {
            const userId = interaction.user.id;
            const currentCoins = await getCoins(userId); // awaitを追加
            const bankCoins = await getBankCoins(userId); // awaitを追加
            const creditPoints = await getCreditPoints(userId); // awaitを追加

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.user.username} さんの情報`)
                .setColor('#ADD8E6')
                .addFields(
                    { name: '現在の所持金', value: `${currentCoins.toLocaleString()} いんコイン`, inline: false },
                    { name: '現在の銀行残高', value: `${bankCoins.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${creditPoints}`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(moneyCommand.data.name, moneyCommand);


const WORK_COOLDOWN_MS = 2 * 60 * 60 * 1000;

const workCommand = {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('2時間に1回、いんコインを稼ぎます。'),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const now = Date.now();
        const lastWork = await getUserLastWorkTime(userId); // awaitを追加

        if (now - lastWork < WORK_COOLDOWN_MS) {
            const timeLeft = WORK_COOLDOWN_MS - (now - lastWork);
            const minutesLeft = Math.ceil(timeLeft / (1000 * 60));
            return interaction.editReply({ content: `まだ仕事できません。あと ${minutesLeft} 分待ってください。` });
        }

        let earnedAmount;
        // ユーザーの職業を取得、なければ「無職」をデフォルトとする
        const userJob = await getUserJob(userId) || "無職"; // awaitを追加
        const userData = await getUserData(userId); // ユーザーデータを取得しておく
        const creditPoints = userData.creditPoints; // awaitは既にgetUserDataで処理されている

        if (userJob && jobSettings.has(userJob)) {
            const jobEarn = jobSettings.get(userJob);
            if (userJob === "Youtuber") {
                // Youtuberの特殊計算: 信用ポイント × (minMultiplierからmaxMultiplierのランダムな倍率)
                if (creditPoints > 0) { // 信用ポイントが正の場合
                    const { minMultiplier, maxMultiplier } = jobSettings.get("Youtuber");
                    const randomMultiplier = Math.floor(Math.random() * (maxMultiplier - minMultiplier + 1)) + minMultiplier;
                    earnedAmount = creditPoints * randomMultiplier;
                } else { // 信用ポイントが0以下の場合は少額
                    earnedAmount = Math.floor(Math.random() * (100 - 10 + 1)) + 10;
                }
            } else if (userJob === "社長") { // 社長職の計算
                const companyId = userData.companyId;
                if (companyId) {
                    const companyData = await getCompanyData(companyId);
                    if (companyData && companyData.ownerId === userId) { // 自分が社長の会社に所属しているか確認
                        const numMembers = companyData.members.length;
                        const { minBase, maxBase, memberBonus } = jobSettings.get("社長");
                        earnedAmount = Math.floor(Math.random() * (maxBase - minBase + 1)) + minBase + (numMembers * memberBonus);
                    } else {
                        // 社長職だが会社データがない、または自分が社長ではない場合のフォールバック（無職と同じ）
                        earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
                    }
                } else {
                    // 社長職だがcompanyIdがない場合のフォールバック（無職と同じ）
                    earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
                }
            } else { // その他の一般職業
                earnedAmount = Math.floor(Math.random() * (jobEarn.max - jobEarn.min + 1)) + jobEarn.min;
            }
        } else {
            // ここはuserJobがMapに存在しない場合 (無職として処理されるため、基本的にはここには来ないはずですが念のため残します)
            earnedAmount = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
        }
        
        // 会社の自動入金設定の処理
        const userCompanyId = userData.companyId;
        if (userCompanyId) {
            const companyData = await getCompanyData(userCompanyId);
            if (companyData && companyData.autoDeposit) { // companyDataがnullでないことを確認
                await updateCompanyDataField(userCompanyId, 'budget', companyData.budget + earnedAmount);
                const embed = new EmbedBuilder()
                    .setTitle('お仕事結果')
                    .setColor('#00FF00')
                    .setDescription(`お疲れ様です！ ${earnedAmount.toLocaleString()} いんコインを獲得しました。\nこの金額は、自動で会社「${companyData.name}」の予算に入金されました。`)
                    .addFields(
                        { name: 'あなたの所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false },
                        { name: '会社の予算', value: `${(await getCompanyData(userCompanyId)).budget.toLocaleString()} いんコイン`, inline: false },
                        { name: '信用ポイント', value: `${await getCreditPoints(userId)}`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
                await interaction.editReply({ embeds: [embed] });
                await addCreditPoints(userId, 1);
                await setUserLastWorkTime(userId, now);
                return; // 自動入金した場合はここで終了
            }
        }

        const newCoins = await addCoins(userId, earnedAmount); // awaitを追加
        await addCreditPoints(userId, 1); // awaitを追加

        await setUserLastWorkTime(userId, now); // awaitを追加

        const embed = new EmbedBuilder()
            .setTitle('お仕事結果')
            .setColor('#00FF00')
            .setDescription(`お疲れ様です！ ${earnedAmount.toLocaleString()} いんコインを獲得しました。`)
            .addFields(
                { name: '現在の残高', value: `${newCoins.toLocaleString()} いんコイン`, inline: false },
                { name: '信用ポイント', value: `${await getCreditPoints(userId)}`, inline: false } // awaitを追加
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(workCommand.data.name, workCommand);

const ROB_COOLDOWN_MS = 3 * 60 * 60 * 1000;

const robCommand = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('他のユーザーからいんコインを盗みます。')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('盗む相手のユーザー')
                .setRequired(true)),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const robberUser = interaction.user;
        const creditPoints = await getCreditPoints(robberUser.id); // awaitを追加

        if (creditPoints < 0) {
            return interaction.editReply({ content: '信用ポイントが負のため、強盗はできません。' });
        }

        const targetUser = interaction.options.getUser('target');
        const now = Date.now();
        const lastRob = await getUserLastRobTime(robberUser.id); // awaitを追加

        if (now - lastRob < ROB_COOLDOWN_MS) {
            const timeLeft = ROB_COOLDOWN_MS - (now - lastRob);
            const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutesLeft = Math.ceil((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            return interaction.editReply({ content: `まだ強盗できません。あと ${hoursLeft} 時間 ${minutesLeft} 分待ってください。` });
        }

        if (robberUser.id === targetUser.id) {
            return interaction.editReply({ content: '自分自身を盗むことはできません！' });
        }

        if (targetUser.bot) {
            return interaction.editReply({ content: 'ボットからいんコインを盗むことはできません！' });
        }

        // 強盗対象は所持金のみ
        const targetCoins = await getCoins(targetUser.id); // awaitを追加
        const robberCoins = await getCoins(robberUser.id); // awaitを追加

        if (targetCoins <= 0) {
            return interaction.editReply({ content: `${targetUser.username} さんは現在いんコインを持っていません。` });
        }

        const successChance = 0.65; // 強盗成功確率
        const isSuccess = Math.random() < successChance;

        let embed = new EmbedBuilder()
            .setTitle('強盗結果')
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await setUserLastRobTime(robberUser.id, now); // awaitを追加

        if (isSuccess) {
            // 盗む金額の割合 (50-65%)
            const stolenPercentage = Math.random() * (0.65 - 0.50) + 0.50;
            const stolenAmount = Math.floor(targetCoins * stolenPercentage);

            await addCoins(targetUser.id, -stolenAmount); // awaitを追加
            await addCoins(robberUser.id, stolenAmount); // awaitを追加
            await addCreditPoints(robberUser.id, -5); // awaitを追加

            embed.setDescription(`強盗成功！ ${targetUser.username} さんから **${stolenAmount.toLocaleString()}** いんコインを盗みました！`)
                 .addFields(
                     { name: `${robberUser.username} の現在の残高`, value: `${(await getCoins(robberUser.id)).toLocaleString()} いんコイン`, inline: true }, // awaitを追加
                     { name: `${targetUser.username} の現在の残高`, value: `${(await getCoins(targetUser.id)).toLocaleString()} いんコイン`, inline: true }, // awaitを追加
                     { name: 'あなたの信用ポイント', value: `${await getCreditPoints(robberUser.id)}`, inline: false } // awaitを追加
                 )
                 .setColor('#00FF00'); // 緑色
        } else {
            // 失敗の場合、所持金の30-45%を失う (変更なし)
            const penaltyPercentage = Math.random() * (0.45 - 0.30) + 0.30;
            const penaltyAmount = Math.floor(robberCoins * penaltyPercentage);
            const newRobberCoins = await addCoins(robberUser.id, -penaltyAmount); // awaitを追加
            await addCreditPoints(robberUser.id, -3); // awaitを追加

            embed.setDescription(`強盗失敗... ${targetUser.username} さんからいんコインを盗むことができませんでした。
罰金として **${penaltyAmount.toLocaleString()}** いんコインを失いました。`)
                 .addFields(
                     { name: `${robberUser.username} の現在の残高`, value: `${newRobberCoins.toLocaleString()} いんコイン`, inline: false },
                     { name: 'あなたの信用ポイント', value: `${await getCreditPoints(robberUser.id)}`, inline: false } // awaitを追加
                 )
                 .setColor('#FF0000'); // 赤色
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(robCommand.data.name, robCommand);

// /deposit コマンド
const depositCommand = {
    data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('所持金を銀行に預けます。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('預ける金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const amount = interaction.options.getInteger('amount');
        const currentCoins = await getCoins(userId); // awaitを追加

        if (currentCoins < amount) {
            return interaction.editReply({ content: `所持金が足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
        }

        await addCoins(userId, -amount); // awaitを追加
        await addBankCoins(userId, amount); // awaitを追加

        const embed = new EmbedBuilder()
            .setTitle('預金完了')
            .setColor('#00FF00')
            .setDescription(`${amount.toLocaleString()} いんコインを銀行に預けました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: true }, // awaitを追加
                { name: '現在の銀行残高', value: `${(await getBankCoins(userId)).toLocaleString()} いんコイン`, inline: true } // awaitを追加
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(depositCommand.data.name, depositCommand);

// /withdraw コマンド
const withdrawCommand = {
    data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('銀行からお金を引き出します。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('引き出す金額')
                .setRequired(true)
                .setMinValue(1)),
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const amount = interaction.options.getInteger('amount');
        const currentBankCoins = await getBankCoins(userId); // awaitを追加

        if (currentBankCoins < amount) {
            return interaction.editReply({ content: `銀行残高が足りません！現在 ${currentBankCoins.toLocaleString()} いんコインが銀行にあります。` });
        }

        await addBankCoins(userId, -amount); // awaitを追加
        await addCoins(userId, amount); // awaitを追加

        const embed = new EmbedBuilder()
            .setTitle('引き出し完了')
            .setColor('#00FF00')
            .setDescription(`${amount.toLocaleString()} いんコインを銀行から引き出しました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: true }, // awaitを追加
                { name: '現在の銀行残高', value: `${(await getBankCoins(userId)).toLocaleString()} いんコイン`, inline: true } // awaitを追加
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(withdrawCommand.data.name, withdrawCommand);

// addMoneyCommand, removeMoneyCommand, giveMoneyCommand, channelMoneyCommand は変更なし
const addMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('add-money')
        .setDescription('指定したユーザーまたはロールにいんコインを追加します。(管理者のみ)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('追加するいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを追加するユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを追加するロールのメンバー')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // 管理者のみ
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let replyMessage = '';
        if (targetUser) {
            const newCoins = await addCoins(targetUser.id, amount); // awaitを追加
            replyMessage = `${targetUser.username} に ${amount.toLocaleString()} いんコインを追加しました。\n現在の残高: ${newCoins.toLocaleString()} いんコイン`;
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member => member.roles.cache.has(targetRole.id) && !member.user.bot);
            let addedCount = 0;
            for (const member of members.values()) {
                await addCoins(member.id, amount); // awaitを追加
                addedCount++;
            }
            replyMessage = `${targetRole.name} ロールの ${addedCount} 人のメンバーに ${amount.toLocaleString()} いんコインを追加しました。`;
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン追加')
            .setColor('#00FF00')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(addMoneyCommand.data.name, addMoneyCommand);

const removeMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('remove-money')
        .setDescription('指定したユーザーまたはロールからいんコインを削除します。(管理者のみ)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('削除するいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを削除するユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを削除するロールのメンバー')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // 管理者のみ
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let replyMessage = '';
        if (targetUser) {
            const newCoins = await addCoins(targetUser.id, -amount); // awaitを追加
            replyMessage = `${targetUser.username} から ${amount.toLocaleString()} いんコインを削除しました。\n現在の残高: ${newCoins.toLocaleString()} いんコイン`;
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member => member.roles.cache.has(targetRole.id) && !member.user.bot);
            let removedCount = 0;
            for (const member of members.values()) {
                await addCoins(member.id, -amount); // awaitを追加
                removedCount++;
            }
            replyMessage = `${targetRole.name} ロールの ${removedCount} 人のメンバーからそれぞれ ${amount.toLocaleString()} いんコインを削除しました。`;
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン削除')
            .setColor('#FF0000')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(removeMoneyCommand.data.name, removeMoneyCommand);

const giveMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('give-money')
        .setDescription('他のユーザーまたはロールのメンバーにいんコインを渡します。')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('渡すいんコインの金額')
                .setRequired(true)
                .setMinValue(1))
        .addUserOption(option =>
            option.setName('user')
                .setDescription('いんコインを渡すユーザー')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('いんコインを渡すロールのメンバー')
                .setRequired(false)),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const giverUser = interaction.user;
        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        const targetRole = interaction.options.getRole('role');

        if (!targetUser && !targetRole) {
            return interaction.editReply({ content: 'ユーザーまたはロールのどちらかを指定してください。' });
        }

        let affectedUsers = [];
        if (targetUser) {
            if (giverUser.id === targetUser.id) {
                return interaction.editReply({ content: '自分自身にいんコインを渡すことはできません！' });
            }
            if (targetUser.bot) {
                return interaction.editReply({ content: 'ボットにいんコインを渡すことはできません！' });
            }
            affectedUsers.push(targetUser);
        } else if (targetRole) {
            await interaction.guild.members.fetch();
            const members = interaction.guild.members.cache.filter(member =>
                member.roles.cache.has(targetRole.id) && !member.user.bot && member.user.id !== giverUser.id
            );
            affectedUsers = Array.from(members.values()).map(member => member.user);
        }

        if (affectedUsers.length === 0) {
            return interaction.editReply({ content: '指定されたユーザーまたはロールのメンバーが見つかりませんでした。' });
        }

        const totalCost = amount * affectedUsers.length;
        const giverCoins = await getCoins(giverUser.id); // awaitを追加

        if (giverCoins < totalCost) {
            const embed = new EmbedBuilder()
                .setTitle('いんコイン送金失敗')
                .setColor('#FFD700')
                .setDescription(`いんコインが足りません！${affectedUsers.length}人へ${amount.toLocaleString()}いんコインを渡すには合計${totalCost.toLocaleString()}いんコインが必要です。\n現在の残高: ${giverCoins.toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            return interaction.editReply({ embeds: [embed] });
        }

        await addCoins(giverUser.id, -totalCost); // awaitを追加

        let replyMessage = '';
        if (targetUser) {
            await addCoins(targetUser.id, amount); // awaitを追加
            replyMessage = `${targetUser.username} に ${amount.toLocaleString()} いんコインを渡しました。\n${giverUser.username} の現在の残高: ${(await getCoins(giverUser.id)).toLocaleString()} いんコイン\n${targetUser.username} の現在の残高: ${(await getCoins(targetUser.id)).toLocaleString()} いんコイン`; // awaitを追加
        } else if (targetRole) {
            for (const user of affectedUsers) {
                await addCoins(user.id, amount); // awaitを追加
            }
            replyMessage = `${targetRole.name} ロールの ${affectedUsers.length} 人のメンバーにそれぞれ ${amount.toLocaleString()} いんコインを渡しました。\n${giverUser.username} の現在の残高: ${(await getCoins(giverUser.id)).toLocaleString()} いんコイン`; // awaitを追加
        }

        const embed = new EmbedBuilder()
            .setTitle('いんコイン送金完了')
            .setColor('#00FF00')
            .setDescription(replyMessage)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(giveMoneyCommand.data.name, giveMoneyCommand);

const channelMoneyCommand = {
    data: new SlashCommandBuilder()
        .setName('channel-money')
        .setDescription('指定したチャンネルでのチャットに報酬を設定します。(管理者のみ)')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('報酬を設定するチャンネル')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('min')
                .setDescription('チャットで獲得できる最低いんコイン')
                .setRequired(true)
                .setMinValue(0))
        .addIntegerOption(option =>
            option.setName('max')
                .setDescription('チャットで獲得できる最大いんコイン')
                .setRequired(true)
                .setMinValue(0)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // 管理者のみ
    async execute(interaction) {
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }

        const channel = interaction.options.getChannel('channel');
        const minAmount = interaction.options.getInteger('min');
        const maxAmount = interaction.options.getInteger('max');

        if (minAmount > maxAmount) {
            return interaction.editReply({ content: '最低金額は最大金額以下である必要があります。' });
        }

        channelChatRewards.set(channel.id, { min: minAmount, max: maxAmount });
        // channelChatRewardsはメモリ内データなのでFirestore保存は不要

        const embed = new EmbedBuilder()
            .setTitle('チャンネル報酬設定')
            .setColor('#00FF00')
            .setDescription(`${channel.name} でのチャット報酬を ${minAmount.toLocaleString()} いんコインから ${maxAmount.toLocaleString()} いんコインに設定しました。`)
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    },
};
client.commands.set(channelMoneyCommand.data.name, channelMoneyCommand);

const jobsCommand = {
    data: new SlashCommandBuilder()
        .setName('jobs')
        .setDescription('職業関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('assign')
                .setDescription('ユーザーに職業を割り当てます。(管理者のみ)')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('職業を割り当てるユーザー')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('job_name')
                        .setDescription('割り当てる職業名')
                        .setRequired(true)
                        .setAutocomplete(true))) // オートコンプリートを有効化
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('ユーザーから職業を削除します。(管理者のみ)')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('職業を削除するユーザー')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('設定されている職業の一覧を表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('my-job')
                .setDescription('自分の現在の職業を表示します。')),
    default_member_permissions: null, // @everyoneが使用可能
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();
        const userData = await getUserData(userId); // awaitを追加
        const creditPoints = userData.creditPoints; // awaitは既にgetUserDataで処理されている

        if (subcommand === 'assign') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const targetUser = interaction.options.getUser('user');
            const jobName = interaction.options.getString('job_name');
            // 社長はassignコマンドで割り当てられないようにする
            if (jobName === "社長") {
                return interaction.editReply({ content: '「社長」は/company addコマンドで会社を作成した際に自動的に割り当てられます。手動で割り当てることはできません。' });
            }
            if (!jobSettings.has(jobName) && jobName !== "無職") { // "無職"も許可する
                return interaction.editReply({ content: `職業 **${jobName}** は存在しません。設定済みの職業から選択してください。` });
            }

            await setUserJob(targetUser.id, jobName); // awaitを追加
            await interaction.editReply({ content: `${targetUser.username} に職業 **${jobName}** を割り当てました。` });

        } else if (subcommand === 'remove') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
            }
            const targetUser = interaction.options.getUser('user');
            
            // ユーザーのデータを取得し、ジョブが存在するか確認
            const targetUserData = await getUserData(targetUser.id);
            if (!targetUserData.job || targetUserData.job === "無職") {
                return interaction.editReply({ content: `${targetUser.username} には現在、職業が割り当てられていません。` });
            }
            if (targetUserData.job === "社長") {
                 return interaction.editReply({ content: '「社長」の職業を削除するには、先に会社を削除するか、他のユーザーに社長を引き継ぐ必要があります。' });
            }
            await setUserJob(targetUser.id, "無職"); // 職業を無職にリセット
            await interaction.editReply({ content: `${targetUser.username} から職業を削除し、「無職」に戻しました。` });

        } else if (subcommand === 'list') {
            if (jobSettings.size === 0) {
                return interaction.editReply({ content: '現在、設定されている職業はありません。' });
            }

            let description = '';
            for (const [jobName, settings] of jobSettings.entries()) {
                if (jobName === "Youtuber") {
                    description += `**${jobName}**: 信用ポイントに応じて変動 (信用が0より高い場合は 信用ポイント×${settings.minMultiplier.toLocaleString()} ～ 信用ポイント×${settings.maxMultiplier.toLocaleString()}、信用が0以下の場合は 10 ～ 100 いんコイン)\n`;
                } else if (jobName === "社長") {
                     description += `**${jobName}**: 会社メンバー数に応じて変動 (${settings.minBase.toLocaleString()} ～ ${settings.maxBase.toLocaleString()} + 会社人数×${settings.memberBonus.toLocaleString()} いんコイン)\n`;
                }
                else if (jobName === "無職") {
                    description += `**${jobName}**: ${settings.min.toLocaleString()} ～ ${settings.max.toLocaleString()} いんコイン (初期状態)\n`;
                }
                else {
                    description += `**${jobName}**: ${settings.min.toLocaleString()} ～ ${settings.max.toLocaleString()} いんコイン\n`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle('設定されている職業一覧')
                .setColor('#ADD8E6')
                .setDescription(description)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'my-job') {
            // ユーザーの職業を取得、なければ「無職」をデフォルトとする
            const currentJob = await getUserJob(userId) || "無職"; // awaitを追加
            let message;
            if (currentJob) {
                if (currentJob === "Youtuber") {
                    // Youtuberの信用ポイントに応じた予測範囲も表示
                    let predictionMessage;
                    if (creditPoints > 0) {
                        const { minMultiplier, maxMultiplier } = jobSettings.get("Youtuber");
                        const minPossible = creditPoints * minMultiplier;
                        const maxPossible = creditPoints * maxMultiplier;
                        predictionMessage = `(現在の信用ポイント ${creditPoints} の場合、約 ${minPossible.toLocaleString()} ～ ${maxPossible.toLocaleString()} いんコイン)`;
                    } else {
                        predictionMessage = `(現在の信用ポイント ${creditPoints} の場合、常に 10 ～ 100 いんコイン)`;
                    }
                    message = `あなたの現在の職業は **${currentJob}** です。\n/work で信用ポイントに応じていんコインを獲得できます。${predictionMessage}`;
                } else if (currentJob === "社長") {
                    const companyId = userData.companyId;
                    if (companyId) {
                        const companyData = await getCompanyData(companyId);
                        if (companyData && companyData.ownerId === userId) {
                            const numMembers = companyData.members.length;
                            const { minBase, maxBase, memberBonus } = jobSettings.get("社長");
                            const minEarned = minBase + (numMembers * memberBonus);
                            const maxEarned = maxBase + (numMembers * memberBonus);
                            message = `あなたの現在の職業は **${currentJob}** です。\n/work で約 ${minEarned.toLocaleString()} ～ ${maxEarned.toLocaleString()} いんコインを獲得できます。\n(現在の会社メンバー数: ${numMembers}人)`;
                        } else {
                             message = `あなたの現在の職業は **${currentJob}** ですが、所属している会社が見つからないか、あなたが社長ではありません。`;
                        }
                    } else {
                        message = `あなたの現在の職業は **${currentJob}** ですが、会社に所属していません。`;
                    }
                }
                else {
                    const jobEarn = jobSettings.get(currentJob);
                    message = `あなたの現在の職業は **${currentJob}** です。\n/work で ${jobEarn.min.toLocaleString()} ～ ${jobEarn.max.toLocaleString()} いんコインを獲得できます。`;
                }
            } else { // これは「無職」が設定されていなかった場合のフォールバックだが、今回は「無職」がデフォルトなので基本的にはここには来ない
                message = '現在、あなたには職業が割り当てられていません。\n/work で 1000 ～ 1500 いんコインを獲得できます。';
            }
            await interaction.editReply({ content: message });
        }
    },
};
client.commands.set(jobsCommand.data.name, jobsCommand);

const jobChangeCommand = {
    data: new SlashCommandBuilder()
        .setName('job-change')
        .setDescription('職業を変更します。費用がかかります。')
        .addStringOption(option =>
            option.setName('job_name')
                .setDescription('変更したい職業名')
                .setRequired(true)
                .setAutocomplete(true)), // オートコンプリートを有効化
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const requestedJob = interaction.options.getString('job_name');
        // ユーザーの現在の職業を取得、なければ「無職」をデフォルトとする
        const currentJob = await getUserJob(userId) || "無職"; // awaitを追加

        if (currentJob === "社長") { // 社長は転職不可
            return interaction.editReply({ content: 'あなたは会社の社長です。「社長」の職業を辞めるには、まず会社を削除するか、他のユーザーに社長を引き継ぐ必要があります。' });
        }
        if (!jobSettings.has(requestedJob) && requestedJob !== "無職") { // "無職"も許可する
            return interaction.editReply({ content: `職業 **${requestedJob}** は存在しません。/jobs list で確認してください。` });
        }

        if (currentJob === requestedJob) {
            return interaction.editReply({ content: `あなたはすでに **${requestedJob}** です。` });
        }
        // 社長には転職できないようにする
        if (requestedJob === "社長") {
            return interaction.editReply({ content: '「社長」の職業は、/company addコマンドで会社を作成した際に自動的に割り当てられます。手動で転職することはできません。' });
        }

        const cost = jobChangeCosts.get(requestedJob);
        if (cost === undefined) { // costが0の場合も考慮し、undefinedの場合のみエラー
            return interaction.editReply({ content: `職業 **${requestedJob}** の転職費用が設定されていません。` });
        }

        const currentCoins = await getCoins(userId); // awaitを追加

        if (currentCoins < cost) {
            return interaction.editReply({ content: `転職費用が足りません！\n**${requestedJob}** への転職には **${cost.toLocaleString()}** いんコイン必要ですが、あなたは **${currentCoins.toLocaleString()}** いんコインしか持っていません。` });
        }

        await addCoins(userId, -cost); // awaitを追加 // 費用を差し引く
        await setUserJob(userId, requestedJob); // awaitを追加 // 職業を割り当てる

        const embed = new EmbedBuilder()
            .setTitle('転職成功！')
            .setColor('#00FF00')
            .setDescription(`あなたは **${requestedJob}** に転職しました！\n費用として **${cost.toLocaleString()}** いんコインを支払いました。`)
            .addFields(
                { name: '現在の所持金', value: `${(await getCoins(userId)).toLocaleString()} いんコイン`, inline: false } // awaitを追加
            )
            .setTimestamp()
            .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

        await interaction.editReply({ embeds: [embed] });
    }
};
client.commands.set(jobChangeCommand.data.name, jobChangeCommand);


const loadCommand = {
    data: new SlashCommandBuilder()
        .setName('load')
        .setDescription('最新のいんコイン情報を取得します。')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('情報を取得したいユーザー')
                .setRequired(false))
        .addBooleanOption(option => 
            option.setName('all')
                .setDescription('全てのユーザーと会社のいんコイン情報を再取得します。(管理者のみ)')
                .setRequired(false)),
    default_member_permissions: null, 
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }

        const loadAll = interaction.options.getBoolean('all');
        const targetUser = interaction.options.getUser('user');

        if (loadAll) {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.editReply({ content: 'このコマンドで全てのユーザーと会社の情報を再取得するには管理者権限が必要です。' });
            }
            if (targetUser) {
                 return interaction.editReply({ content: '「全てのユーザー」と特定のユーザーを同時に指定することはできません。' });
            }

            const { users: loadedUsersCount, companies: loadedCompaniesCount } = await syncAllDataFromFirestore(); 
            const embed = new EmbedBuilder()
                .setTitle('いんコイン情報一括再取得')
                .setColor('#00FF00')
                .setDescription(`Firestoreから**${loadedUsersCount.toLocaleString()}人分**のユーザー情報と**${loadedCompaniesCount.toLocaleString()}件**の会社情報を全て再取得し、キャッシュを更新しました。`) 
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else if (targetUser) { 
            const targetUserId = targetUser.id;
            const targetUserData = await getUserData(targetUserId); 

            if (!targetUserData.isRegistered) {
                return interaction.editReply({ content: `${targetUser.username} さんはいんコインシステムに登録されていません。` });
            }

            // companyIdが存在し、companyDataCacheにない場合（削除された会社）はcompanyIdをnullにリセット
            if (targetUserData.companyId && !companyDataCache.has(targetUserData.companyId)) {
                targetUserData.companyId = null;
                targetUserData.job = '無職';
                await saveUserDataToFirestore(targetUserId, targetUserData);
            }

            const embed = new EmbedBuilder()
                .setTitle(`${targetUser.username} さんのいんコイン情報`)
                .setColor('#00FF00')
                .addFields(
                    { name: '所持金', value: `${targetUserData.balances.toLocaleString()} いんコイン`, inline: false },
                    { name: '銀行残高', value: `${targetUserData.bankBalances.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${targetUserData.creditPoints}`, inline: false },
                    { name: '職業', value: `${targetUserData.job}`, inline: false },
                    { name: 'チャンネル登録者数', value: `${targetUserData.subscribers.toLocaleString()} 人`, inline: false },
                    { name: '所属会社', value: targetUserData.companyId ? (await getCompanyData(targetUserData.companyId))?.name || '不明' : 'なし', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

        } else { 
            const currentUserData = await getUserData(userId); 

            if (!currentUserData.isRegistered) {
                return interaction.editReply({ content: 'あなたはいんコインシステムに登録されていません。`/register` コマンドで登録してください。' });
            }

            // companyIdが存在し、companyDataCacheにない場合（削除された会社）はcompanyIdをnullにリセット
            if (currentUserData.companyId && !companyDataCache.has(currentUserData.companyId)) {
                currentUserData.companyId = null;
                currentUserData.job = '無職';
                await saveUserDataToFirestore(userId, currentUserData);
            }
            
            const embed = new EmbedBuilder()
                .setTitle(`${interaction.user.username} さんのいんコイン情報`)
                .setColor('#00FF00')
                .addFields(
                    { name: '現在の所持金', value: `${currentUserData.balances.toLocaleString()} いんコイン`, inline: false },
                    { name: '現在の銀行残高', value: `${currentUserData.bankBalances.toLocaleString()} いんコイン`, inline: false },
                    { name: '信用ポイント', value: `${currentUserData.creditPoints}`, inline: false },
                    { name: '職業', value: `${currentUserData.job}`, inline: false },
                    { name: 'チャンネル登録者数', value: `${currentUserData.subscribers.toLocaleString()} 人`, inline: false },
                    { name: '所属会社', value: currentUserData.companyId ? (await getCompanyData(currentUserData.companyId))?.name || '不明' : 'なし', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(loadCommand.data.name, loadCommand);

// === companyコマンド群 ===
const companyCommand = {
    data: new SlashCommandBuilder()
        .setName('company')
        .setDescription('会社関連のコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('会社関連のコマンドヘルプを表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('新しい会社を作成します。(社長のみ)')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('会社名')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('daily_salary')
                        .setDescription('メンバーへの日給')
                        .setRequired(true)
                        .setMinValue(0)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('deposit')
                .setDescription('会社の予算に資金を預け入れます。')
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('預け入れる金額')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('withdraw')
                .setDescription('会社の予算から資金を引き出します。(社長のみ)')
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('引き出す金額')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('alldeposit')
                .setDescription('workコマンドの収益を自動で会社予算に入れるか設定します。(社長のみ)')
                .addBooleanOption(option =>
                    option.setName('toggle')
                        .setDescription('自動入金をONにするかOFFにするか')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('join')
                .setDescription('会社に参加します。')
                .addStringOption(option =>
                    option.setName('company_name')
                        .setDescription('参加したい会社名')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('自分または指定した会社の情報を表示します。')
                .addStringOption(option =>
                    option.setName('company_name')
                        .setDescription('情報を表示したい会社名 (未指定で自分の会社)')
                        .setRequired(false)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('自分の会社を削除します。(社長のみ)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave')
                .setDescription('所属している会社を辞めます。')), // 新しい /company leave コマンド
    default_member_permissions: null,
    async execute(interaction) {
        const userId = interaction.user.id;
        if (!db || firebaseAuthUid === 'anonymous') {
            return interaction.editReply({ content: 'ボットのデータベース接続がまだ準備できていません。数秒待ってからもう一度お試しください。' });
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('会社コマンドヘルプ')
                .setDescription('会社関連の利用可能なコマンドとその説明です。')
                .setColor('ADD8E6')
                .addFields(
                    { name: '/company add <会社名> <日給>', value: '新しい会社を作成します。あなたが社長になります。(社長のみ)', inline: false },
                    { name: '/company deposit <金額>', value: 'あなたの所持金から会社予算に預け入れます。', inline: false },
                    { name: '/company withdraw <金額>', value: '会社の予算からあなたの所持金に引き出します。(社長のみ)', inline: false },
                    { name: '/company alldeposit <true|false>', value: 'workコマンドで得た収益を自動で会社予算に入れるか設定します。(社長のみ)', inline: false },
                    { name: '/company join <会社名>', value: '指定した会社に参加します。毎日日給が支払われます。', inline: false },
                    { name: '/company info [会社名]', value: '自分の所属する会社、または指定した会社の情報を表示します。', inline: false },
                    { name: '/company leave', value: '所属している会社を辞めます。(社長以外)', inline: false }, // ヘルプメッセージに追加
                    { name: '/company delete', value: 'あなたの会社を削除します。会社のいんコインは消滅します。(社長のみ)', inline: false },
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [helpEmbed] });
        } else if (subcommand === 'add') {
            const companyName = interaction.options.getString('name');
            const dailySalary = interaction.options.getInteger('daily_salary');
            const allCompanies = await getAllCompanies();
            const existingCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (existingCompany) {
                return interaction.editReply({ content: 'その会社名は既に存在します。別の名前を試してください。' });
            }
            const userData = await getUserData(userId);
            if (userData.companyId) {
                const currentCompany = await getCompanyData(userData.companyId);
                return interaction.editReply({ content: `あなたは既に会社「${currentCompany.name}」に所属しています。新しい会社を作成する前に、現在の会社を抜けるか削除してください。` });
            }
            const companyId = crypto.randomUUID(); // ユニークなIDを生成
            const newCompanyData = {
                ...defaultCompanyData,
                name: companyName,
                ownerId: userId, // 社長はコマンド実行者
                dailySalary: dailySalary,
                members: [{ id: userId, username: interaction.user.username }], // 社長自身をメンバーに追加
                lastPayoutTime: Date.now() // 作成時に最終支払い時刻を初期化
            };
            await saveCompanyDataToFirestore(companyId, newCompanyData);
            await updateUserDataField(userId, 'companyId', companyId); // ユーザーデータに会社IDを紐付け
            await setUserJob(userId, "社長"); // 社長職を割り当てる
            
            const embed = new EmbedBuilder()
                .setTitle('会社設立成功！')
                .setColor('#00FF00')
                .setDescription(`会社「**${companyName}**」を設立しました！あなたが社長です。
日給: ${dailySalary.toLocaleString()} いんコイン
会社ID: \`${companyId}\``)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });

            // 社長にDMを送信
            const ownerDMEmbed = new EmbedBuilder()
                .setTitle('会社について')
                .setDescription(`会社の作成おめでとうございます！会社は毎日**夜9時**に維持費が引き出されます。
維持費は日給も含まれ、**日給×人数 + 300000**コインが引き落とされます。
/company depositでコインを入れて維持費を払いましょう！
日給はもちろん会社の人に支払われます。`)
                .setColor('#0099ff')
                .setTimestamp();
            try {
                await interaction.user.send({ embeds: [ownerDMEmbed] });
            } catch (dmError) {
                console.error(`Failed to send company creation DM to owner ${userId}:`, dmError);
            }

        } else if (subcommand === 'deposit') {
            const amount = interaction.options.getInteger('amount');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const currentCoins = await getCoins(userId);
            if (currentCoins < amount) {
                return interaction.editReply({ content: `所持金が足りません！現在 ${currentCoins.toLocaleString()} いんコイン持っています。` });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (!companyData || !companyData.name) { // Company data might be corrupted or deleted
                 await updateUserDataField(userId, 'companyId', null); // 紐付けを解除
                 await setUserJob(userId, "無職"); // 無職に戻す
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            await addCoins(userId, -amount); // ユーザーの所持金から減らす
            await updateCompanyDataField(userData.companyId, 'budget', companyData.budget + amount);
            const embed = new EmbedBuilder()
                .setTitle('会社予算に預け入れ')
                .setColor('#00FF00')
                .setDescription(`${amount.toLocaleString()} いんコインを会社「${companyData.name}」の予算に預け入れました。
現在の会社予算: ${(await getCompanyData(userData.companyId)).budget.toLocaleString()} いんコイン
あなたの所持金: ${(await getCoins(userId)).toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'withdraw') {
            const amount = interaction.options.getInteger('amount');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '会社の予算から引き出しできるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) { // Company data might be corrupted or deleted
                 await updateUserDataField(userId, 'companyId', null); // 紐付けを解除
                 await setUserJob(userId, "無職"); // 無職に戻す
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            if (companyData.budget < amount) {
                return interaction.editReply({ content: `会社の予算が足りません！現在 ${companyData.budget.toLocaleString()} いんコインが会社の予算にあります。` });
            }
            await updateCompanyDataField(userData.companyId, 'budget', companyData.budget - amount);
            await addCoins(userId, amount); // ユーザーの所持金に加える
            const embed = new EmbedBuilder()
                .setTitle('会社予算から引き出し')
                .setColor('#00FF00')
                .setDescription(`${amount.toLocaleString()} いんコインを会社「${companyData.name}」の予算から引き出しました。
現在の会社予算: ${(await getCompanyData(userData.companyId)).budget.toLocaleString()} いんコイン
あなたの所持金: ${(await getCoins(userId)).toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'alldeposit') {
            const toggle = interaction.options.getBoolean('toggle');
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '自動入金を設定できるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) { // Company data might be corrupted or deleted
                 await updateUserDataField(userId, 'companyId', null); // 紐付けを解除
                 await setUserJob(userId, "無職"); // 無職に戻す
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
            }
            await updateCompanyDataField(userData.companyId, 'autoDeposit', toggle);
            const status = toggle ? 'ON' : 'OFF';
            const embed = new EmbedBuilder()
                .setTitle('自動入金設定')
                .setColor('#00FF00')
                .setDescription(`会社「${companyData.name}」のworkコマンド自動入金を **${status}** に設定しました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'join') {
            const companyName = interaction.options.getString('company_name');
            const allCompanies = await getAllCompanies();
            const targetCompany = allCompanies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
            if (!targetCompany) {
                return interaction.editReply({ content: `会社「${companyName}」は見つかりませんでした。` });
            }
            const userData = await getUserData(userId);
            if (userData.companyId) {
                const currentCompany = await getCompanyData(userData.companyId);
                return interaction.editReply({ content: `あなたは既に会社「${currentCompany.name}」に所属しています。新しい会社に参加する前に、現在の会社を抜けるか削除してください。` });
            }
            if (targetCompany.members.some(m => m.id === userId)) {
                return interaction.editReply({ content: `あなたは既に会社「${companyName}」のメンバーです。` });
            }
            const updatedMembers = [...targetCompany.members, { id: userId, username: interaction.user.username }];
            await saveCompanyDataToFirestore(targetCompany.id, { ...targetCompany, members: updatedMembers });
            await updateUserDataField(userId, 'companyId', targetCompany.id);
            const embed = new EmbedBuilder()
                .setTitle('会社に参加成功！')
                .setColor('#00FF00')
                .setDescription(`会社「**${targetCompany.name}**」に参加しました！
日給: ${targetCompany.dailySalary.toLocaleString()} いんコイン`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'info') {
            const companyNameOption = interaction.options.getString('company_name');
            let targetCompanyData = null;
            if (companyNameOption) {
                const allCompanies = await getAllCompanies();
                targetCompanyData = allCompanies.find(c => c.name.toLowerCase() === companyNameOption.toLowerCase());
                if (!targetCompanyData) {
                    return interaction.editReply({ content: `会社「${companyNameOption}」は見つかりませんでした。` });
                }
            } else {
                const userData = await getUserData(userId);
                if (!userData.companyId) {
                    return interaction.editReply({ content: 'あなたはどの会社にも所属していません。会社に参加するか作成してください。または、会社名を指定して情報を検索してください。' });
                }
                targetCompanyData = await getCompanyData(userData.companyId);
                if (!targetCompanyData || !targetCompanyData.name) {
                     await updateUserDataField(userId, 'companyId', null);
                     await setUserJob(userId, "無職"); // 無職に戻す
                     return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。再度会社に参加するか、新しい会社を作成してください。' });
                }
            }
            const ownerUser = await client.users.fetch(targetCompanyData.ownerId).catch(() => ({ username: '不明なユーザー' }));
            const membersList = targetCompanyData.members.map(m => `- ${m.username}`).join('\n') || 'なし';
            const embed = new EmbedBuilder()
                .setTitle(`会社「${targetCompanyData.name}（日給 ${targetCompanyData.dailySalary.toLocaleString()}コイン）」の情報`)
                .setColor('#FFFF00')
                .addFields(
                    { name: '社長', value: ownerUser.username, inline: true },
                    { name: '日給', value: `${targetCompanyData.dailySalary.toLocaleString()} いんコイン`, inline: true },
                    { name: '現在の予算', value: `${targetCompanyData.budget.toLocaleString()} いんコイン`, inline: false },
                    { name: '自動入金', value: targetCompanyData.autoDeposit ? 'ON' : 'OFF', inline: true },
                    { name: 'メンバー数', value: `${targetCompanyData.members.length} 人`, inline: true },
                    { name: 'メンバーリスト', value: membersList, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'delete') {
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。' });
            }
            const companyData = await getCompanyData(userData.companyId);
            if (companyData.ownerId !== userId) {
                return interaction.editReply({ content: '会社を削除できるのは社長のみです。' });
            }
            if (!companyData || !companyData.name) {
                 await updateUserDataField(userId, 'companyId', null);
                 await setUserJob(userId, "無職"); // 無職に戻す
                 return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。' });
            }
            // 会社メンバーのcompanyIdをnullにリセットし、職業を「無職」に戻す
            for (const member of companyData.members) {
                await updateUserDataField(member.id, 'companyId', null);
                await setUserJob(member.id, "無職");
            }
            await deleteCompanyFromFirestore(userData.companyId);
            const embed = new EmbedBuilder()
                .setTitle('会社削除完了')
                .setColor('#FF0000')
                .setDescription(`会社「**${companyData.name}**」を削除しました。会社のいんコインは全て消滅しました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'leave') { // 新しい /company leave コマンドの処理
            const userData = await getUserData(userId);
            if (!userData.companyId) {
                return interaction.editReply({ content: 'あなたはどの会社にも所属していません。' });
            }

            const companyData = await getCompanyData(userData.companyId);
            if (!companyData || !companyData.name) {
                // Company data might be corrupted or deleted, so clean up user data
                await updateUserDataField(userId, 'companyId', null);
                await setUserJob(userId, "無職");
                return interaction.editReply({ content: '所属している会社のデータが見つかりませんでした。会社から脱退扱いになりました。' });
            }

            if (companyData.ownerId === userId) {
                return interaction.editReply({ content: 'あなたは会社の社長です。会社を辞めるには、まず `/company delete` コマンドで会社を削除するか、他のメンバーに社長を引き継いでください。' });
            }

            // メンバーリストから自分を削除
            const updatedMembers = companyData.members.filter(member => member.id !== userId);
            await saveCompanyDataToFirestore(companyData.id, { ...companyData, members: updatedMembers });

            // ユーザー情報を更新
            await updateUserDataField(userId, 'companyId', null);
            await setUserJob(userId, "無職");

            const embed = new EmbedBuilder()
                .setTitle('会社を辞めました')
                .setColor('#FFD700')
                .setDescription(`あなたは会社「**${companyData.name}**」を辞めました。\nあなたの職業は「無職」に戻りました。`)
                .setTimestamp()
                .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.editReply({ embeds: [embed] });
        }
    },
};
client.commands.set(companyCommand.data.name, companyCommand);

const pingCommand = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Botの応答時間をテストします。'),
    default_member_permissions: null,
    async execute(interaction) {
        const ping = client.ws.ping;
        await interaction.editReply(`Pong! (${ping}ms)`);
    },
};
client.commands.set(pingCommand.data.name, pingCommand);

const echoCommand = {
    data: new SlashCommandBuilder()
        .setName('echo')
        .setDescription('入力したメッセージを繰り返します。')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('繰り返したいメッセージ')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const message = interaction.options.getString('message');
        await interaction.editReply({ content: '正常に動作しました。\n(このメッセージはあなただけに表示されています)' });
        await interaction.channel.send(message);
    },
};
client.commands.set(echoCommand.data.name, echoCommand);

const senddmCommand = {
    data: new SlashCommandBuilder()
        .setName('senddm')
        .setDescription('指定したユーザーにBot経由でDMを送信します。')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('DMを送信するユーザー')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('送信するメッセージ')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const target = interaction.options.getMember('target');
        const message = interaction.options.getString('message');
        try {
            await target.send(message);
            await interaction.editReply({ content: `<@${target.id}>にDMを送信しました。` });
        } catch (error) {
            await interaction.editReply({ content: 'DMの送信に失敗しました。' });
            console.error(error);
        }
    },
};
client.commands.set(senddmCommand.data.name, senddmCommand);

const authPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('auth-panel')
        .setDescription('認証パネルをチャンネルに表示します。')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('認証後に付与するロールを指定します。')
                .setRequired(true)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const authRoleOption = interaction.options.getRole('role');
        if (!authRoleOption) {
            await interaction.editReply({ content: '認証パネルを送信するには、付与するロールを指定する必要があります。' });
            return;
        }
        await interaction.editReply({
            content: '認証パネルをチャンネルに送信しました。'
        });
        const roleToAssign = authRoleOption.id;
        const authButton = new ButtonBuilder()
            .setCustomId(`auth_start_${roleToAssign}`)
            .setLabel('認証')
            .setStyle(ButtonStyle.Primary);
        const actionRow = new ActionRowBuilder().addComponents(authButton);
        const authEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('認証')
            .setDescription('こちらから認証をお願いします。');
        await interaction.channel.send({
            embeds: [authEmbed],
            components: [actionRow],
        });
    },
};
client.commands.set(authPanelCommand.data.name, authPanelCommand);

const authCommand = {
    data: new SlashCommandBuilder()
        .setName('auth')
        .setDescription('認証コードを入力して認証を完了します。')
        .addStringOption(option =>
            option.setName('code')
                .setDescription('DMに送信された認証コード')
                .setRequired(true)),
    default_member_permissions: null,
    async execute(interaction) {
        const code = interaction.options.getString('code');
        const userId = interaction.user.id;
        const authData = authChallenges.get(userId);
        if (!authData) {
            return interaction.editReply({
                content: '認証リクエストが見つかりません。まずサーバーで認証ボタンを押してください。'
            });
        }
        if (Date.now() - authData.timestamp > 3 * 60 * 1000) {
            authChallenges.delete(userId);
            return interaction.editReply({
                content: '有効な認証コードが見当たりません。もう一度認証ボタンからやり直してください。'
            });
        }
        if (authData.code === code) {
            const guild = client.guilds.cache.get(authData.guildId);
            if (!guild) {
                return interaction.editReply({ content: '認証したサーバーが見つかりません。' });
            }
            const member = await guild.members.fetch(userId);
            const authRole = guild.roles.cache.get(authData.roleToAssign);
            if (member && authRole) {
                await member.roles.add(authRole);
                authChallenges.delete(userId);
                return interaction.editReply({
                    content: `認証に成功しました！ ${authRole.name} ロールを付与しました。`
                });
            } else {
                return interaction.editReply({
                    content: '認証は成功しましたが、ロールを付与できませんでした。サーバー管理者に連絡してください。'
                });
            }
        } else {
            return interaction.editReply({
                content: '認証コードが正しくありません。もう一度お試しください。'
            });
        }
    },
};
client.commands.set(authCommand.data.name, authCommand);

const helpCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Botのコマンド一覧を表示します。'),
    default_member_permissions: null,
    async execute(interaction) {
        const helpEmbed = new EmbedBuilder()
            .setTitle('Bot Commands List')
            .setDescription('利用可能なコマンドとその説明です。')
            .setColor('ADFF2F')
            .addFields(
                { name: '/ping', value: 'Botの応答時間をテストします。', inline: false },
                { name: '/echo <message>', value: '入力したメッセージを繰り返します。(管理者のみ)', inline: false },
                { name: '/senddm <target> <message>', value: '指定したユーザーにDMを送信します。(管理者のみ)', inline: false },
                { name: '/auth-panel <role>', value: '認証パネルをチャンネルに表示し、ボタンで認証を開始します。付与するロールの指定は必須です。このコマンドは管理者権限が必要です。', inline: false },
                { name: '/auth <code>', value: 'DMで送信された認証コードを入力して認証を完了します。', inline: false },
                { name: '/ticket-panel <category> <role1> [role2] [role3] [role4]', value: 'チケットパネルをチャンネルに表示し、チケット作成ボタンを設置します。チケットチャンネルは指定されたカテゴリーに作成され、指定したロールに閲覧権限が付与されます。', inline: false },
                { name: '/money help', value: 'いんコイン関連のコマンドヘルプを表示します。', inline: false },
                { name: '/jobs list', value: '設定されている職業の一覧を表示します。', inline: false },
                { name: '/load [user] [all:true]', value: '自分、特定のユーザー、または全てのユーザーのいんコイン情報をFirestoreから再取得して表示します。(allオプションは管理者のみ)', inline: false },
                { name: '/company help', value: '会社関連のコマンドヘルプを表示します。', inline: false },
                { name: '/help', value: 'このコマンド一覧を表示します。', inline: false }
            );
        await interaction.editReply({ embeds: [helpEmbed] });
    },
};
client.commands.set(helpCommand.data.name, helpCommand);

const ticketPanelCommand = {
    data: new SlashCommandBuilder()
        .setName('ticket-panel')
        .setDescription('チケットパネルをチャンネルに表示します。')
        .addChannelOption(option =>
            option.setName('category')
                .setDescription('チケットチャンネルを作成するカテゴリー')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption(option =>
            option.setName('role1')
                .setDescription('チケット閲覧権限を付与する必須ロール')
                .setRequired(true))
        .addRoleOption(option =>
            option.setName('role2')
                .setDescription('チケット閲覧権限を付与する任意ロール')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role3')
                .setDescription('チケット閲覧権限を付与する任意ロール')
                .setRequired(false))
        .addRoleOption(option =>
            option.setName('role4')
                .setDescription('チケット閲覧権限を付与する任意ロール')
                .setRequired(false)),
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        const ticketCategory = interaction.options.getChannel('category');
        const rolesToAssign = [
            interaction.options.getRole('role1')?.id,
            interaction.options.getRole('role2')?.id,
            interaction.options.getRole('role3')?.id,
            interaction.options.getRole('role4')?.id,
        ].filter(id => id);
        if (!ticketCategory || rolesToAssign.length === 0) {
            return interaction.editReply({ content: 'チケットパネルを送信するには、カテゴリーと最低1つのロールを指定する必要があります。' });
        }
        const panelId = Math.random().toString(36).substring(7);
        ticketPanels.set(panelId, { categoryId: ticketCategory.id, roles: rolesToAssign });
        await interaction.editReply({
            content: 'チケットパネルをチャンネルに送信しました。'
        });
        const ticketButton = new ButtonBuilder()
            .setCustomId(`ticket_create_${panelId}`)
            .setLabel('チケットを作成')
            .setStyle(ButtonStyle.Success);
        const actionRow = new ActionRowBuilder().addComponents(ticketButton);
        const rolesMention = rolesToAssign.map(id => `<@&${id}>`).join(', ');
        const ticketEmbed = new EmbedBuilder()
            .setColor('#32CD32')
            .setTitle('チケットが開かれました')
            .setDescription(`サポートが必要な内容をこちらに記入してください。担当者が対応します。
このチャンネルは、あなたと ${rolesMention} のみに表示されています。`);
        await interaction.channel.send({
            embeds: [ticketEmbed],
            components: [actionRow]
        });
    },
};
client.commands.set(ticketPanelCommand.data.name, ticketPanelCommand);


async function registerCommands() {
    // ギルド（サーバー）限定コマンド (いんコイン関連 + /load + /jobs + /job-change + /register)
    const guildCommandsData = [
        registerCommand.data.toJSON(), // 新しい /register コマンドを登録
        gamblingCommand.data.toJSON(),
        moneyCommand.data.toJSON(), // 統合された moneyCommand を登録
        workCommand.data.toJSON(),
        robCommand.data.toJSON(),
        giveMoneyCommand.data.toJSON(),
        addMoneyCommand.data.toJSON(),
        removeMoneyCommand.data.toJSON(),
        channelMoneyCommand.data.toJSON(),
        loadCommand.data.toJSON(),
        depositCommand.data.toJSON(),   // /deposit コマンドを登録
        withdrawCommand.data.toJSON(),  // /withdraw コマンドを登録
        jobsCommand.data.toJSON(),      // 変更された jobsCommand を登録
        jobChangeCommand.data.toJSON(), // 新しい jobChangeCommand を登録
        companyCommand.data.toJSON(), // companyコマンドを登録
    ];

    // グローバルコマンド (ユーティリティ、認証、チケット関連)
    const globalCommandsData = [
        pingCommand.data.toJSON(),
        echoCommand.data.toJSON(),
        senddmCommand.data.toJSON(),
        authPanelCommand.data.toJSON(),
        authCommand.data.toJSON(),
        helpCommand.data.toJSON(),
        ticketPanelCommand.data.toJSON(),
    ];

    const rest = new REST().setToken(DISCORD_TOKEN);

    try {
        if (GUILD_ID) {
            console.log(`Registering ${guildCommandsData.length} guild-specific commands for guild ${GUILD_ID}.`);
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: guildCommandsData });
            console.log('Guild-specific commands successfully registered.');
        } else {
            console.warn('GUILD_ID is not set. Guild-specific commands will not be registered.');
        }

        console.log(`Registering ${globalCommandsData.length} global commands.`);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: globalCommandsData });
        console.log('Global commands successfully registered.');

    } catch (error) {
        console.error("Failed to register commands:", error);
    }
}

client.once('ready', async () => {
    console.log(`Ready! Logged in as ${client.user.tag}`);

    // Firebase Configuration (Canvas環境が優先、なければ.envから読み込み)
    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
        measurementId: process.env.FIREBASE_MEASUREMENT_ID
    };

    // Firebase初期化
    firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);

    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token.length > 0) {
        try {
            await signInWithCustomToken(auth, __initial_auth_token);
            firebaseAuthUid = auth.currentUser.uid;
            console.log(`Firebase authenticated with custom token as: ${firebaseAuthUid}`);
        } catch (error) {
            console.error("Error signing in with custom token, signing in anonymously:", error);
            await signInAnonymously(auth);
            firebaseAuthUid = auth.currentUser.uid;
            console.log(`Firebase authenticated anonymously as: ${firebaseAuthUid}`);
        }
    } else {
        await signInAnonymously(auth);
        firebaseAuthUid = auth.currentUser.uid;
        console.log(`Firebase authenticated anonymously as: ${firebaseAuthUid}`);
    }

    // コマンド登録
    await registerCommands();
    client.user.setPresence({
        activities: [{
            name: `/help`,
            type: ActivityType.Playing,
        }],
        status: 'online',
    });
});

client.on('interactionCreate', async interaction => {
    // deferReplyをtry/catchブロックの外で、かつ最初に実行するように変更
    // これにより、コマンドの処理が遅延してもDiscordAPIとのタイムアウトを防ぎます。
    if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ ephemeral: true }).catch(error => {
            console.error("Failed to defer reply:", error);
            // タイムアウトしたインタラクションはここで処理を中断
            return;
        });
    }

    // deferReplyが成功したか、またはdeferReplyではない（ボタンなど）の場合に処理を続行
    if (!interaction.deferred && !interaction.replied && interaction.isChatInputCommand()) {
        // deferReplyが失敗した場合、処理をこれ以上進めない
        return;
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        // deferReplyが成功している場合はeditReply
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ content: '不明なコマンドです！' });
        } else {
            // そうでない場合はreply (ただしdeferReplyが失敗しているケースは既に中断されているはず)
            return interaction.reply({ content: '不明なコマンドです！', ephemeral: true });
        }
    }

    try {
        // default_member_permissions が明示的に設定されている（つまりnullではない）コマンドのみ、権限チェックを行う
        if (command.default_member_permissions && interaction.member && !interaction.member.permissions.has(command.default_member_permissions)) {
            return interaction.editReply({ content: 'このコマンドを実行するには管理者権限が必要です。' });
        }
        
        // `/register` コマンド以外のいんコイン関連コマンドは、登録済みユーザーのみが実行可能
        // 管理者コマンドは対象外とする (add-money, remove-moneyなど)
        const nonAdminMoneyCommands = ['gambling', 'money', 'work', 'rob', 'give-money', 'deposit', 'withdraw', 'jobs', 'job-change', 'load', 'company'];
        // companyコマンドは内部で登録チェックを行うため、ここで全てのcompanyサブコマンドをブロックしない
        // companyコマンドが「add」の場合、未登録ユーザーでも実行できるようにする
        const isCompanyAddCommand = interaction.commandName === 'company' && interaction.options.getSubcommand() === 'add';

        if (nonAdminMoneyCommands.includes(interaction.commandName) && interaction.commandName !== 'register' && !isCompanyAddCommand) {
            const userData = await getUserData(interaction.user.id);
            if (!userData.isRegistered) {
                return interaction.editReply({ content: 'このコマンドを使用するには、まず `/register` コマンドでいんコインシステムに登録してください。' });
            }
        }

        await command.execute(interaction);

        // 信用ポイントが負になった場合の処理を、コマンド実行後にチェック
        const userId = interaction.user.id;
        const creditPoints = await getCreditPoints(userId); 
        const punishedForNegativeCredit = await getUserPunishedForNegativeCredit(userId); 
        if (creditPoints < 0 && !punishedForNegativeCredit) {
            const guild = interaction.guild;
            if (guild) {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    const initialBankCoins = await getBankCoins(userId); 
                    const initialCurrentCoins = await getCoins(userId); 
                    const totalAvailableCoins = initialBankCoins + initialCurrentCoins; // 総資産

                    const deductionPercentage = Math.floor(Math.random() * (90 - 75 + 1)) + 75; // 75%から90%
                    let intendedTotalDeduction = Math.floor(totalAvailableCoins * (deductionPercentage / 100)); // 総資産から算出される本来の罰金

                    // 意図される合計罰金が負にならないようにする
                    if (intendedTotalDeduction < 0) intendedTotalDeduction = 0;

                    let deductedFromBank = 0;
                    let deductedFromCurrent = 0;
                    let dmMessage = '';
                    let actualTotalDeducted = 0;

                    // まず銀行残高から差し引く
                    if (initialBankCoins > 0) {
                        deductedFromBank = Math.min(initialBankCoins, intendedTotalDeduction);
                        await addBankCoins(userId, -deductedFromBank); 
                        actualTotalDeducted += deductedFromBank;
                    }
                    
                    // 残りの罰金を所持金から差し引く
                    const remainingPenaltyToDeduct = intendedTotalDeduction - deductedFromBank;
                    if (remainingPenaltyToDeduct > 0) { 
                        deductedFromCurrent = Math.min(initialCurrentCoins, remainingPenaltyToDeduct);
                        await addCoins(userId, -deductedFromCurrent); 
                        actualTotalDeducted += deductedFromCurrent;
                    }

                    // DMメッセージの構築
                    if (actualTotalDeducted > 0) {
                        if (deductedFromBank > 0 && deductedFromCurrent > 0) {
                            dmMessage = `信用ポイントが負になったため、銀行残高から **${deductedFromBank.toLocaleString()}** いんコイン、さらに所持金から **${deductedFromCurrent.toLocaleString()}** いんコインが差し引かれました。`;
                        } else if (deductedFromBank > 0) {
                            dmMessage = `信用ポイントが負になったため、銀行残高から **${deductedFromBank.toLocaleString()}** いんコインが差し引かれました。`;
                        } else if (deductedFromCurrent > 0) {
                            dmMessage = `信用ポイントが負になったため、銀行に残高がなかったため所持金から **${deductedFromCurrent.toLocaleString()}** いんコインが差し引かれました。`;
                        }
                    } else {
                        dmMessage = `信用ポイントが負になりましたが、銀行と所持金に残高がなかったため、いんコインは差し引かれませんでした。`;
                    }

                    // 信用ポイントを-10にリセットし、罰金を適用済みとしてマーク
                    await updateUserDataField(userId, 'creditPoints', -10); 
                    await setUserPunishedForNegativeCredit(userId, true); 

                    const dmEmbed = new EmbedBuilder()
                        .setTitle('信用ポイント低下による処罰')
                        .setDescription(`${dmMessage}
あなたの現在の所持金は **${(await getCoins(userId)).toLocaleString()}** いんコインです。
あなたの銀行残高は現在 **${(await getBankCoins(userId)).toLocaleString()}** いんコインです。
信用ポイントは **${(await getCreditPoints(userId))}** にリセットされました。`) 
                        .setColor('#FF0000')
                        .setTimestamp();
                    
                    try {
                        await member.send({ embeds: [dmEmbed] });
                    } catch (dmError) {
                        console.error(`Failed to send DM to ${member.user.tag}:`, dmError);
                    }
                }
            }
        }

    } catch (error) {
        console.error(`Error executing command ${interaction.commandName}:`, error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'コマンドの実行中にエラーが発生しました！' });
        } else {
            // deferReplyが失敗してここでエラーになった場合は、editReplyではなくreply（ただし、上にdeferReplyのcatchがあるので基本ここには来ない）
            await interaction.reply({ content: 'コマンドの実行中にエラーが発生しました！', ephemeral: true });
        }
    }
} else if (interaction.isAutocomplete()) { // オートコンプリートの処理
    if (interaction.commandName === 'jobs' && interaction.options.getSubcommand() === 'assign') {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === 'job_name') {
            const filtered = Array.from(jobSettings.keys()).filter(choice =>
                choice.toLowerCase().startsWith(focusedOption.value.toLowerCase()) && choice !== "社長" // 社長はオートコンプリートから除外
            );
            // "無職" も候補に含める
            if ("無職".toLowerCase().startsWith(focusedOption.value.toLowerCase())) {
                if (!filtered.includes("無職")) {
                    filtered.unshift("無職");
                }
            }
            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
    } else if (interaction.commandName === 'job-change') {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === 'job_name') {
            const filtered = Array.from(jobSettings.keys()).filter(choice =>
                choice.toLowerCase().startsWith(focusedOption.value.toLowerCase()) && choice !== "社長" // 社長はオートコンプリートから除外
            );
             // "無職" も候補に含める
            if ("無職".toLowerCase().startsWith(focusedOption.value.toLowerCase())) {
                if (!filtered.includes("無職")) {
                    filtered.unshift("無職");
                }
            }
            await interaction.respond(
                filtered.map(choice => ({ name: choice, value: choice }))
            );
        }
    } else if (interaction.commandName === 'company' && (interaction.options.getSubcommand() === 'join' || interaction.options.getSubcommand() === 'info')) {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === 'company_name') {
            const allCompanies = await getAllCompanies();
            const filtered = allCompanies.filter(company =>
                company.name.toLowerCase().startsWith(focusedOption.value.toLowerCase())
            ).map(company => ({ name: `${company.name}（日給 ${company.dailySalary.toLocaleString()}コイン）`, value: company.name })); // nameとvalueを分ける
            await interaction.respond(filtered);
        }
    }
}
 else if (interaction.isButton()) {
    try {
        if (interaction.customId.startsWith('auth_start_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const [_, __, roleToAssign] = interaction.customId.split('_');
            
            const member = interaction.guild.members.cache.get(interaction.user.id);
            if (member && member.roles.cache.has(roleToAssign)) {
                return interaction.editReply({ content: 'あなたは既に認証されています。' });
            }

            const num1 = Math.floor(Math.random() * (30 - 10 + 1)) + 10;
            const num2 = Math.floor(Math.random() * (60 - 31 + 1)) + 31;
            
            const authCode = (num1 + num2).toString();
            const equation = `${num1} + ${num2}`;
            
            authChallenges.set(interaction.user.id, {
                code: authCode,
                equation: equation,
                guildId: interaction.guild.id,
                roleToAssign: roleToAssign,
                timestamp: Date.now()
            });

            const dmEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('認証コード')
                .setDescription(`認証コードを送信しました。認証番号は以下の数式の答えです。
有効時間は3分です。

**${equation}**

この数式の答えを認証番号として、DMで \`/auth 認証番号\` と入力してください。`);
            
            try {
                await interaction.user.send({ embeds: [dmEmbed] });
                await interaction.editReply({
                    content: '認証コードをDMに送信しました。ご確認ください。',
                });
            } catch (error) {
                console.error('DM送信中にエラーが発生しました:', error);
                authChallenges.delete(interaction.user.id);
                await interaction.editReply({
                    content: 'DMの送信に失敗しました。DM設定をご確認ください。',
                });
            }
        } else if (interaction.customId.startsWith('ticket_create_')) {
            await interaction.deferReply({ ephemeral: true });

            const [_, __, panelId] = interaction.customId.split('_');
            const panelConfig = ticketPanels.get(panelId);

            if (!panelConfig) {
                return interaction.editReply({ content: 'このチケットパネルは無効です。再度作成してください。' });
            }

            const { categoryId, roles } = panelConfig;
            const guild = interaction.guild;
            const member = interaction.member;

            if (!guild || !member) {
                return interaction.editReply({ content: 'この操作はサーバー内でのみ実行可能です。' });
            }

            const existingTicketChannel = guild.channels.cache.find(c =>
                c.name.startsWith(`ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`) &&
                c.parentId === categoryId
            );

            if (existingTicketChannel) {
                return interaction.editReply({
                    content: `あなたはすでにチケットを持っています: ${existingTicketChannel}`,
                });
            }
            
            const channelName = `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

            const permissionOverwrites = [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: member.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                },
                {
                    id: client.user.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                },
            ];
            
            roles.forEach(roleId => {
                if (roleId) {
                    permissionOverwrites.push({
                        id: roleId,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                    });
                }
            });

            try {
                const newChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: categoryId,
                    permissionOverwrites: permissionOverwrites,
                });

                const closeButton = new ButtonBuilder()
                        .setCustomId('ticket_close')
                        .setLabel('終了')
                        .setStyle(ButtonStyle.Danger);

                const actionRow = new ActionRowBuilder().addComponents(closeButton);

                const rolesMention = roles.map(id => `<@&${id}>`).join(', ');

                const ticketEmbed = new EmbedBuilder()
                    .setColor('#32CD32')
                    .setTitle('チケットが開かれました')
                    .setDescription(`サポートが必要な内容をこちらに記入してください。担当者が対応します。
このチャンネルは、あなたと ${rolesMention} のみに表示されています。`);

                await newChannel.send({
                    content: `${member}`,
                    embeds: [ticketEmbed],
                    components: [actionRow]
                });

                await interaction.editReply({
                    content: `チケットが作成されました: ${newChannel}`,
                });

            } catch (error) {
                console.error('チケットチャンネルの作成中にエラーが発生しました:', error);
                await interaction.editReply({ content: 'チケットの作成に失敗しました。', ephemeral: true });
            }
        } else if (interaction.customId === 'ticket_close') {
            await interaction.deferReply();
            try {
                await interaction.editReply({ content: 'チケットを終了します。このチャンネルは数秒後に削除されます。' });
                setTimeout(() => {
                    interaction.channel.delete('チケットが終了されました');
                }, 3000);
            } catch (error) {
                console.error('チケットチャンネルの削除中にエラーが発生しました:', error);
                await interaction.editReply({ content: 'チケットの削除に失敗しました。', ephemeral: true });
            }
        }
    } catch (error) {
        console.error('ボタン処理中にエラーが発生しました:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: 'ボタンの実行中にエラーが発生しました！', ephemeral: true });
        } else {
            await interaction.reply({ content: 'ボタンの実行中にエラーが発生しました！', ephemeral: true });
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const channelId = message.channel.id;
    const rewardConfig = channelChatRewards.get(channelId);

    if (rewardConfig) {
        let earnedAmount = Math.floor(Math.random() * (rewardConfig.max - rewardConfig.min + 1)) + rewardConfig.min;

        // 信用ポイントが負の場合、獲得額を30%に減少
        const creditPoints = await getCreditPoints(message.author.id); 
        if (creditPoints < 0) {
            earnedAmount = Math.floor(earnedAmount * 0.30); // 30%に減少
            // チャット報酬は常に0以上になるようにする
            if (earnedAmount < 0) earnedAmount = 0; 
        }

        await addCoins(message.author.id, earnedAmount); // awaitを追加 // メモリに保存
    }
});

client.login(DISCORD_TOKEN);
