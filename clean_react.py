import os

app_file = "/Users/kaat/Documents/jetreader/src/admin/App.tsx"

# Read using utf-8 with surrogateescape to handle non-UTF-8 bytes cleanly
with open(app_file, 'r', encoding='utf-8', errors='surrogateescape') as f:
    content = f.read()

# 1. Remove ProUpgradeBanner definition completely
start_banner = content.find("const ProUpgradeBanner: React.FC = () => {")
if start_banner != -1:
    # Find the end of this component (it ends before const LectorDashboard)
    end_banner = content.find("const LectorDashboard: React.FC = () => {")
    if end_banner != -1:
        content = content[:start_banner] + content[end_banner:]
        print("Success: Removed ProUpgradeBanner definition.")
    else:
        print("Error: Could not find const LectorDashboard to end banner search.")
else:
    print("Warning: ProUpgradeBanner definition not found.")

# 2. Simplify LectorDashboard (Keep the types and other functions below it intact!)
start_dash = content.find("const LectorDashboard: React.FC = () => {")
# LectorDashboard ends right before the ItemsPage divider comment
end_dash = content.find("/* ------------------------------------------------------------------ */\n/*  ItemsPage")
if end_dash == -1:
    end_dash = content.find("/* ------------------------------------------------------------------ */\r\n/*  ItemsPage")

if start_dash != -1 and end_dash != -1:
    new_dashboard_code = """const LectorDashboard: React.FC = () => {
    const { t } = useTranslation();
    const [ stats, setStats ] = React.useState( {
        total_books: 0,
        total_articles: 0,
        total_magazines: 0,
        total_qa: 0,
        total_items: 0,
        total_views: 0,
        total_reads: 0,
    } );
    const [ statsLoading, setStatsLoading ] = React.useState( false );

    const fetchStats = React.useCallback( ( force = false ) => {
        setStatsLoading( true );
        fetch( `${API_BASE}/dashboard${force ? '?force=1' : ''}`, {
            headers: { 'X-WP-Nonce': getNonce() },
        } )
            .then( ( res ) => res.json() )
            .then( ( data ) => {
                if ( data && ! data.code ) setStats( data );
                else dbg( 'dashboard stats error:', data );
            } )
            .catch( ( err ) => dbg( 'dashboard fetch error:', err ) )
            .finally( () => setStatsLoading( false ) );
    }, [] );

    React.useEffect( () => { fetchStats(); }, [] );

    const statCards = [
        { label: t('dashboard.totalBooks'), value: stats.total_books, iconBg: 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400', icon: '📚' },
        { label: t('dashboard.totalArticles'), value: stats.total_articles, iconBg: 'bg-green-500/10 dark:bg-green-500/20 text-green-600 dark:text-green-400', icon: '📄' },
        { label: t('dashboard.totalMagazines'), value: stats.total_magazines, iconBg: 'bg-purple-500/10 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400', icon: '🗞️' },
        { label: t('dashboard.totalQA'), value: stats.total_qa, iconBg: 'bg-orange-500/10 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400', icon: '💬' },
        { label: t('dashboard.totalViews'), value: stats.total_views, iconBg: 'bg-cyan-500/10 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400', icon: '👁️' },
        { label: t('dashboard.totalReads'), value: stats.total_reads, iconBg: 'bg-pink-500/10 dark:bg-pink-500/20 text-pink-600 dark:text-pink-400', icon: '📖' },
    ];

    return (
        <div className="p-6">
            <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                        {t('dashboard.title')}
                    </h1>
                    <p className="mt-1 text-gray-500 dark:text-gray-400 text-sm">
                        {t('dashboard.welcome')}
                    </p>
                </div>
                <button
                    onClick={ () => fetchStats( true ) }
                    disabled={ statsLoading }
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-750 disabled:opacity-50 transition-colors"
                    title="Refresh statistics"
                >
                    <span className={ statsLoading ? 'animate-spin' : '' }>↻</span>
                    { statsLoading ? 'Loading…' : 'Refresh Stats' }
                </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
                { statCards.map( ( card ) => (
                    <div
                        key={ card.label }
                        className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3.5 sm:p-5 flex items-center gap-3 sm:gap-4 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200"
                    >
                        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${card.iconBg}`}>
                            <span className="text-xl sm:text-2xl">{ card.icon }</span>
                        </div>
                        <div className="min-w-0">
                            <span className="block text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-white tracking-tight leading-none mb-1">
                                { card.value.toLocaleString() }
                            </span>
                            <p className="text-[10px] sm:text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider leading-tight whitespace-normal break-words">
                                { card.label }
                            </p>
                        </div>
                    </div>
                ) ) }
            </div>

            { /* ── Quick Actions ── */ }
            <div style={{ background:'#fff', borderRadius:'16px', border:'1px solid #e5e7eb', padding:'22px', boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }} className="dark:bg-gray-800 dark:border-gray-700">
                <p style={{ fontSize:'11px', fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:'#9ca3af', marginBottom:'16px' }}>
                    { t('dashboard.quickActions') }
                </p>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:'12px' }}>
                    { [
                        { page:'jetreader-items',     icon:'📚', label: t('dashboard.manageLibraryItems'), primary:true  },
                        { page:'jetreader-constants', icon:'🏷️', label: t('dashboard.manageCategories'),   primary:false },
                        { page:'jetreader-settings',  icon:'⚙️', label: t('dashboard.settingsLink'),       primary:false },
                        { page:'jetreader-about',     icon:'💬', label: t('dashboard.supportLink'),         primary:false },
                    ].map( (action) => (
                        <NavLink
                            key={ action.page }
                            page={ action.page }
                            style={{
                                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                                gap:'10px', padding:'20px 12px', borderRadius:'14px', textDecoration:'none',
                                textAlign:'center', cursor:'pointer', transition:'all 0.15s',
                                background: action.primary
                                    ? 'linear-gradient(135deg,var(--jr-p600,#4f46e5),var(--jr-p700,#4338ca))'
                                    : '#f9fafb',
                                border: action.primary ? 'none' : '1.5px solid #e5e7eb',
                                color: action.primary ? '#fff' : '#374151',
                                boxShadow: action.primary ? '0 4px 14px rgba(79,70,229,0.25)' : 'none',
                            }}
                        >
                            <span style={{ fontSize:'26px', lineHeight:1 }}>{ action.icon }</span>
                            <span style={{ fontSize:'13px', fontWeight:600, lineHeight:1.4 }}>{ action.label }</span>
                        </NavLink>
                    ) ) }
                </div>
            </div>

            { /* ── Shortcode Guide ── */ }
            <div style={{ marginTop:'24px', background:'#fff', borderRadius:'16px', border:'1px solid #e5e7eb', overflow:'hidden', boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }} className="dark:bg-gray-800 dark:border-gray-700">

                { /* Header */ }
                <div style={{ background:'linear-gradient(135deg,var(--jr-p600,#4f46e5),var(--jr-p800,#3730a3))', padding:'22px 26px' }}>
                    <h2 style={{ fontSize:'18px', fontWeight:700, color:'#fff', margin:0, display:'flex', alignItems:'center', gap:'8px' }}>
                        📋 { t('dashboard.shortcodeGuideTitle') }
                    </h2>
                    <p style={{ fontSize:'14px', color:'rgba(255,255,255,0.75)', marginTop:'5px', marginBottom:0 }}>
                        { t('dashboard.shortcodeGuideDesc') }
                    </p>
                </div>

                { /* Shortcode rows */ }
                <div>
                    { [
                        { code:'[jetreader_library]',                       label: t('dashboard.scLibraryLabel'),      desc: t('dashboard.scLibraryDesc'),      badge:'⭐' },
                        { code:'[jetreader_library type="book"]',           label: t('dashboard.scLibraryBooksLabel'), desc: t('dashboard.scLibraryBooksDesc'), badge:'📚' },
                        { code:'[jetreader_library types="book,magazine"]', label: t('dashboard.scLibraryTypesLabel'), desc: t('dashboard.scLibraryTypesDesc'), badge:'🗂️' },
                        { code:'[jetreader_featured]',                      label: t('dashboard.scFeaturedLabel'),     desc: t('dashboard.scFeaturedDesc'),     badge:'✨' },
                    ].map( ( sc, i, arr ) => (
                        <div
                            key={ sc.code }
                            style={{ borderBottom: i < arr.length - 1 ? '1px solid #f3f4f6' : 'none', padding:'16px 22px' }}
                            className="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors dark:border-gray-700/60"
                        >
                            { /* Top row: badge icon + label */ }
                            <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'10px' }}>
                                <div style={{ width:'38px', height:'38px', borderRadius:'10px', background:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:'20px' }}
                                     className="dark:bg-gray-700">
                                    { sc.badge }
                                </div>
                                <div>
                                    <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                        <span style={{ fontSize:'15px', fontWeight:700, color:'#111827' }} className="dark:text-white">
                                            { sc.label }
                                        </span>
                                    </div>
                                    <span style={{ fontSize:'13px', color:'#6b7280', lineHeight:1.5 }} className="dark:text-gray-400">
                                        { sc.desc }
                                    </span>
                                </div>
                            </div>
                            { /* Bottom row: code chip */ }
                            <div style={{ paddingLeft:'48px' }}>
                                <ShortcodeChip
                                    code={ sc.code }
                                    hint={ t('dashboard.scCopyHint') }
                                    copied={ t('dashboard.scCopied') }
                                />
                            </div>
                        </div>
                    ) ) }
                </div>
            </div>
        </div>
    );
};

"""
    content = content[:start_dash] + new_dashboard_code + content[end_dash:]
    print("Success: Simplified LectorDashboard.")
else:
    print("Error: Could not find LectorDashboard or ItemsPage divider.")

# 3. Remove displays reminder banner from ItemsPage
# Find the reminder banner code block and remove it
banner_code = """            { /* ── Embed reminder banner — Pro only (Displays not in Lite) ── */ }
            { !isLite && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm">
                <span className="text-blue-500 text-lg shrink-0">💡</span>
                <span className="text-blue-800 dark:text-blue-200 flex-1">
                    { t( 'dashboard.itemsBannerText' ) }
                </span>
                <NavLink
                    page="jetreader-displays"
                    className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 underline underline-offset-2 whitespace-nowrap"
                >
                    { t( 'dashboard.itemsBannerLink' ) }
                </NavLink>
            </div>
            ) }"""

if banner_code in content:
    content = content.replace(banner_code, "")
    print("Success: Removed displays reminder banner directly.")
else:
    # Try dynamic search
    target_lines_start = content.find("Embed reminder banner")
    if target_lines_start != -1:
        end_pos = content.find(")\n            }", target_lines_start)
        if end_pos == -1:
            end_pos = content.find(")\r\n            }", target_lines_start)
        if end_pos != -1:
            comment_start = content.rfind("{ /* ── Embed", 0, target_lines_start)
            if comment_start != -1:
                content = content[:comment_start] + content[end_pos + 14:]
                print("Success: Removed displays reminder banner dynamically.")

# 4. Simplify AboutPage (remove isPro and ProUpgradeBanner reference)
content = content.replace("    const isPro = false;\n    const info =", "    const info =")
content = content.replace("    const isPro = false;\r\n    const info =", "    const info =")
content = content.replace("            { !isPro && <ProUpgradeBanner /> }", "")
content = content.replace("            { !isPro && <ProUpgradeBanner /> }\r\n", "")
content = content.replace("            { !isPro && <ProUpgradeBanner /> }\n", "")
print("Success: Simplified AboutPage.")

# 5. Write everything back
with open(app_file, 'w', encoding='utf-8', errors='surrogateescape') as f:
    f.write(content)

print("All App.tsx replacements completed successfully!")
