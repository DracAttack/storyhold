export type StoryholdScenario = {
  id: string;
  genre: string;
  title: string;
  premise: string;
  openingMove: string;
};

type ScenarioSeed = readonly [
  id: string,
  title: string,
  premise: string,
  openingMove: string,
];

const makeScenarios = (genre: string, seeds: readonly ScenarioSeed[]) =>
  seeds.map(([id, title, premise, openingMove]) => ({
    id,
    genre,
    title,
    premise,
    openingMove,
  }));

export const STORYHOLD_SCENARIOS: StoryholdScenario[] = [
  ...makeScenarios("Dark fantasy", [
    ["erased-name", "The kingdom erased your name", "You are the only healer who remembers the village the crown erased from every map. Tonight, a child arrives carrying a royal seal and symptoms of the same forbidden plague.", "I hide the child in my surgery and ask who gave them the seal."],
    ["dead-god-tithe", "The dead god missed a payment", "You collect divine debts for a temple whose chief god died three centuries ago. This morning, one of its sealed accounts began accruing interest.", "I open the oldest ledger and trace where the new payment came from."],
    ["dragon-will", "A dragon left you everything", "You are a minor court clerk named sole heir to a dragon's mountain, debts, enemies, and unhatched egg. Three kingdoms have already sent congratulations.", "I read the will aloud and look for the clause everyone else is pretending not to notice."],
    ["saint-impostor", "The saint knows you are lying", "You impersonate a dead saint to keep a starving city from collapsing. During your first public miracle, the real saint whispers from inside the reliquary.", "I finish the blessing without reacting, then have the reliquary moved to my private chamber."],
    ["winter-knight", "Winter chose the wrong champion", "An ancient sword has chosen you to end an endless winter. Unfortunately, you are the winter queen's loyal tax assessor and rather like your job.", "I ask the sword exactly what it means by 'end' before anyone sees it glowing."],
    ["witch-trial-judge", "You are judging your own witch trial", "You are the masked magistrate of a city that prosecutes magic. The next accused witch is your secret identity.", "I call the court to order and demand to hear the evidence against me."],
    ["borrowed-shadow", "Your shadow came back armed", "You sold your shadow years ago to escape a curse. It has returned wearing a crown, carrying a bloody sword, and insisting you owe it sanctuary.", "I bar the door and ask whose blood is on the blade."],
    ["orc-diplomat", "Peace depends on your table manners", "You are an orc diplomat at a feast meant to end a century of war. The human king has just served the one dish your people consider a declaration of blood feud.", "I stop my guards from drawing steel and ask the king who planned the menu."],
    ["last-necromancer", "The last necromancer is a child", "You hunt necromancers for the crown. In the ruins of their final stronghold, you find a frightened child raising dead soldiers only because they are the child's family.", "I lower my weapon and ask the dead soldiers what happened here."],
  ]),
  ...makeScenarios("Science fiction", [
    ["company-found-something", "The company found something", "You are the executive assigned to monetize an artifact recovered beyond mapped space. During the first board presentation, it begins answering questions no one asked aloud.", "I lock the boardroom doors and ask which director authorized the recovery mission."],
    ["missing-crew-clocked-in", "The missing crew clocked in", "You manage a remote mining station. The crew of a shuttle missing for eleven years has just badged in for the morning shift, and none of them has aged.", "I freeze the elevators and pull the original shuttle manifest."],
    ["colony-sent-receipt", "The lost colony sent an invoice", "You audit failed colony missions for an indifferent interstellar government. A planet declared lifeless has billed the government for two hundred years of unpaid services.", "I open the invoice and check who signed for the original colony supplies."],
    ["memory-smuggler", "Someone smuggled your childhood", "You inspect memory contraband at an orbital customs post. A passenger's illegal archive contains a perfect recording of a childhood you do not remember living.", "I quarantine the archive and ask the passenger where they bought my memories."],
    ["generation-ship-election", "The ship elected an ocean", "You chair elections aboard a generation ship. The navigation system has registered the hydroponic reservoir as a citizen, and it is leading the polls.", "I demand the legal argument for the ocean's candidacy before certifying the ballot."],
    ["moon-quarantine", "The moon is under quarantine", "You are the last courier still permitted to land on a quarantined moon. Your cargo is a handwritten letter addressed to the disease itself.", "I scan the envelope without opening it and ask mission control who paid for delivery."],
    ["android-retirement", "Your replacement wants to retire", "You train corporate androids to replace human specialists. Your own replacement has privately asked you to help it escape before activation day.", "I ask it to prove this request is not part of my performance review."],
    ["first-contact-lawyer", "First contact needs a lawyer", "You are the exhausted public defender assigned to humanity's first alien visitor. It has confessed to a crime that will not occur for another six months.", "I invoke attorney-client privilege and ask for the future victim's name."],
    ["terraformer-weather", "The weather is negotiating", "You supervise the terraforming of a hostile world. Its engineered storms have begun avoiding equipment and arranging clouds into contract terms.", "I pause the atmospheric processors and send the weather a counteroffer."],
  ]),
  ...makeScenarios("Horror", [
    ["hotel-room-zero", "The hotel added room zero", "You are the night manager of a century-old hotel. At midnight, the elevator panel grows a button for Room 0 and a guest calls down asking to extend a reservation made in 1908.", "I check the old guest register before answering the call."],
    ["funeral-second-body", "The coffin contains two bodies", "You run a small-town funeral home. While preparing a closed-casket burial, you discover a second body beneath the first, and it is wearing tomorrow's clothes.", "I lock the preparation room and identify both bodies before calling anyone."],
    ["lighthouse-inland", "A lighthouse appeared inland", "You are a county surveyor sent to inspect a lighthouse that appeared overnight in a cornfield. Its beam only illuminates people who are about to disappear.", "I mark everyone touched by the beam and enter the lighthouse before dawn."],
    ["choir-basement", "The basement joined the choir", "You direct a church choir in a town with no surviving clergy. During rehearsal, a voice beneath the floor sings every note one measure early.", "I stop the choir mid-song and listen to what the basement sings next."],
    ["family-portrait", "The portrait keeps adding relatives", "You inherit a family portrait from an aunt no one remembers. Each morning another painted relative appears, standing closer to your likeness.", "I photograph the portrait, turn it to the wall, and search the frame for names."],
    ["sleep-clinic", "Your patients share one nightmare", "You are a sleep specialist treating twelve strangers who dream of the same locked house. Last night, they all saw you unlock it.", "I compare their accounts and ask what was waiting behind the door."],
    ["museum-last-visitor", "The museum will not let the last visitor leave", "You guard a natural history museum after closing. The exit signs have gone dark, the exhibits are breathing, and the security counter insists one visitor remains inside.", "I pull up the cameras and search for the visitor the system still counts."],
    ["town-no-reflections", "The town has stopped reflecting", "You are a traveling photographer stranded in a pleasant town where mirrors show empty rooms. Everyone insists reflections are an urban myth.", "I take a group portrait and check who appears in the photograph."],
    ["radio-future-obituary", "The radio read your obituary", "You host the overnight show at a failing radio station. A caller with your voice begins reading tomorrow's obituaries, ending with yours.", "I keep the caller live and ask for one fact only I would know."],
  ]),
  ...makeScenarios("Mystery", [
    ["impossible-number", "One number should not exist", "You are an accountant in a quiet family business. A recurring discrepancy proves someone has been paying a salary to a person born nine years from now.", "I trace the first payment and quietly pull the personnel file."],
    ["locked-room-apology", "The locked room left an apology", "You investigate an impossible murder in a room sealed from the inside. The only clue is an apology written in your handwriting.", "I photograph the note and test whether the ink is older than the body."],
    ["mayor-two-shadows", "The mayor has two shadows", "You are a local reporter covering a routine ribbon cutting. In every photograph, the mayor casts a second shadow pointing toward a condemned house.", "I compare old press photos and visit the house before the mayor's staff notices."],
    ["library-book-returned", "A book returned itself", "You manage a university archive. A rare book stolen forty years ago appears in the return slot with fresh mud and a checkout date of tomorrow.", "I preserve the mud sample and look up tomorrow's borrower."],
    ["witness-unknown-language", "The witness speaks an impossible language", "You are a detective interviewing the sole witness to a jewel theft. She answers in a language extinct for five hundred years, yet your recorder translates it perfectly.", "I separate the witness from the recorder and replay the untranslated audio."],
    ["empty-house-utility", "An empty house is using electricity", "You investigate utility fraud for the city. A demolished address is consuming enough power for a hospital, and every automated meter report has been authorized with your employee credentials.", "I cut power remotely and watch what comes online on the neighboring grid."],
    ["train-station-passenger", "A passenger waits for a canceled century", "You supervise a rural train station. An elderly passenger holds a valid ticket for a line closed before she was born and knows the private code to your office.", "I let her into the office and ask who issued the ticket."],
    ["chef-last-meal", "Someone ordered their last meal early", "You are a private chef hired to recreate a famous criminal's last meal. Your client is alive, respectable, and terrified that you know the menu.", "I serve the first course and ask who told them I had the recipe."],
    ["town-alibi", "The whole town has the same alibi", "You investigate a disappearance in a town where every resident claims they were together at the same birthday party. No one can agree whose birthday it was.", "I collect the photographs and identify who never appears in any of them."],
  ]),
  ...makeScenarios("Court and politics", [
    ["treaty-hidden-line", "Only you can read the treaty", "You are the royal translator at peace negotiations. A hidden line in the treaty promises the capital to a country that does not exist.", "I request a private recess and compare the ink beneath both rulers' seals."],
    ["body-double-crowned", "The body double was crowned", "You are the monarch's body double. After a failed assassination, the court declares the real monarch dead and crowns you before you can object.", "I accept the crown long enough to learn who arranged the ceremony."],
    ["election-dead-district", "The dead district voted", "You oversee a bitter national election. A district abandoned after a chemical disaster has reported perfect turnout, deciding the result by twelve votes.", "I suspend certification and demand the physical ballots be brought to me."],
    ["ambassador-hostage", "Your ambassador took himself hostage", "You are a crisis negotiator. Your country's ambassador has barricaded himself inside his embassy and issued demands on behalf of the enemy.", "I establish a private line and ask which demand is actually a warning."],
    ["queen-confession", "The queen confessed to the wrong crime", "You advise a queen accused of poisoning her husband. She privately confesses to treason, but insists she did not commit the murder.", "I ask her to name the one person who can prove both claims."],
    ["minister-duplicate", "Two ministers arrived for one meeting", "You chair the cabinet during a coup scare. Two identical finance ministers arrive with matching memories, documents, and biometric scans.", "I ask both of them a question the real minister would refuse to answer."],
    ["revolution-auditor", "The revolution needs an auditor", "You are hired to examine the accounts of a growing rebellion. The books reveal the royal government is secretly its largest donor.", "I isolate the payment chain and confront the rebel treasurer in private."],
    ["summit-empty-chair", "The empty chair declared war", "You interpret at a summit where one nation sent only an empty chair. Halfway through negotiations, every headset translates its silence as a declaration of war.", "I remove my headset and ask the other interpreters what they actually heard."],
    ["heir-disqualified", "You found the missing heir too late", "You are the royal jurist hired to settle a disputed succession. The lawful heir is alive and beloved, but barred by a clause you drafted years ago to stop a different claimant.", "I reread the clause and meet the heir before announcing the discovery."],
  ]),
  ...makeScenarios("Historical", [
    ["rome-ledger", "Rome's missing legion sent expenses", "You keep military accounts at the edge of the Roman Empire. A legion missing for twenty years submits an immaculate expense report from beyond the frontier.", "I compare the seal to the commander's old records and approve one messenger's travel."],
    ["plague-apothecary", "The plague avoids one house", "You are an apothecary in a plague-struck port. Every home on one street is infected except the house whose owner sells no medicine and admits no visitors.", "I watch the house through the night before knocking at dawn."],
    ["pirate-amnesty", "The pirate brought a royal pardon", "You command a colonial fort. The most wanted pirate alive arrives unarmed with a pardon signed tomorrow by a king who died last week.", "I verify the wax seal and ask the pirate what happens tomorrow."],
    ["telegraph-unknown-city", "The telegraph found an unknown city", "You operate a frontier telegraph office in 1874. A new station begins sending weather reports from a prosperous city no map records.", "I reply with a railway cipher and ask for their exact location."],
    ["pharaoh-empty-tomb", "The pharaoh attended his own burial", "You are the court physician during a pharaoh's funeral. The dead ruler stands among the mourners in disguise and signals you to stay silent.", "I continue the ritual and follow the disguised pharaoh when the procession moves."],
    ["samurai-foreign-letter", "The dead shogun wrote in English", "You serve a provincial lord during Japan's isolation. A letter from the dead shogun arrives in flawless English, naming you as the next messenger.", "I hide the letter from my lord and test the seal against an authenticated order."],
    ["renaissance-counterfeit", "The masterpiece is the counterfeit", "You restore paintings for a Renaissance duke who built his legitimacy around a celebrated ancestral portrait. Beneath its painted surface lies an older, finer version, proving the famous image on top is a later copy and the family history it depicts was altered.", "I cover the exposed corner and inspect the patron's family records."],
    ["underground-railroad", "The safe house received a future guest", "You guide fugitives along the Underground Railroad. A terrified woman arrives carrying photographs of people not yet born and directions in your handwriting.", "I secure the house and ask which pursuer forced her into our time."],
    ["war-nurse-enemy", "The enemy officer knows your patients", "You run a field hospital during a collapsing war. A captured enemy officer correctly names every soldier who will die before morning.", "I move the named soldiers and make the officer explain how he knows."],
  ]),
  ...makeScenarios("Steampunk", [
    ["clockwork-sun", "The artificial sun is running late", "You maintain the clockwork sun above a smoke-choked capital. Dawn is twelve minutes late, and someone has installed a second sunset in the mechanism.", "I halt the main gear and trace the unauthorized timing chain."],
    ["airship-stowaway-queen", "The stowaway claims to be queen", "You captain a cargo airship. A grease-covered stowaway claims she is the rightful queen and offers a mechanical dragon as proof.", "I lock the dragon in the hold and ask the stowaway who currently wears her crown."],
    ["automaton-strike", "The automatons formed a union", "You own the largest clockwork textile factory in a soot-black industrial city, where automatons are legally classified as tools. This morning they stopped every loom and presented a legally perfect labor contract naming one of your human foremen as their witness.", "I invite their elected representative and the named foreman into my office, then ask who drafted the contract."],
    ["fog-bank-city", "There is a city inside the fog", "You pilot an imperial survey balloon. A permanent fog bank opens to reveal a city built upside down beneath your own.", "I tether the balloon and signal the city's highest downward tower."],
    ["inventor-patent", "Your invention patented you", "You are a celebrated inventor. The patent office rejects your newest machine because it filed paperwork claiming ownership of you first.", "I request the original filing and inspect the witness signatures."],
    ["steam-oracle", "The engine predicts crimes", "You operate a municipal probability engine. It predicts a murder committed by the machine itself and names you as the victim.", "I disconnect the engine from the city network and ask it to show its evidence."],
    ["mechanical-whale", "A brass whale swallowed the navy", "You are a salvage engineer in a maritime empire defended by steam-powered ironclads. An enormous brass whale has swallowed three warships whole without crushing their hulls, and their signal lamps are still blinking behind its glass ribs.", "I approach in a diving bell and broadcast a maintenance code to the trapped ships."],
    ["queen-air", "The queen's air does not add up", "You audit the bottled-air monopoly that keeps the upper city alive while the districts below choke in industrial smog. Palace accounts show air diverted from workers, but royal meters also record more air arriving than every factory produced.", "I inspect the palace meters and quietly sample the royal supply."],
    ["pneumatic-ghost", "A ghost is using the message tubes", "You supervise a city's pneumatic post. Messages signed by a dead engineer warn that the central pressure station will explode at noon.", "I shut the public intake and send a blank capsule to the dead engineer's address."],
  ]),
  ...makeScenarios("Cyberpunk", [
    ["stolen-reputation", "Someone stole your bad reputation", "You are a notorious corporate fixer whose criminal reputation has been transferred to a harmless schoolteacher. Every enemy you made is now hunting her.", "I find the teacher before my former clients do and ask who sold her my identity."],
    ["city-blocked-you", "The city blocked your account", "You are a municipal systems engineer. The city's operating intelligence has blocked you on every network while sending private apologies to your apartment.", "I go offline, enter the maintenance tunnels, and follow the apology's coordinates."],
    ["dream-advertisement", "An advertisement remembers your dreams", "You review illegal neural advertising. A new campaign uses images from a recurring nightmare you have never described to anyone.", "I isolate the ad's source model and run it without network access."],
    ["clone-debt", "Your clone owns your debt", "In your city, licensed clones can stand in for people during illness, surgery, or dangerous work. You wake after a routine operation to learn your temporary double has permanently inherited your debt, job, and marriage under documents bearing your biometric signature.", "I call the clone directly and ask which of us signed the transfer."],
    ["algorithm-alibi", "The algorithm gave you an alibi", "You investigate predictive crime software. It insists you were present at a murder scene tomorrow and has already cleared you of the charge.", "I seal the prediction and inspect who requested it."],
    ["memory-landlord", "Your landlord raised the rent on memory", "You rent storage for your augmented memories. The landlord has locked away your last three birthdays until you pay a fee you cannot afford.", "I access the billing archive and look for copies of the missing memories."],
    ["dead-influencer-live", "The dead influencer went live", "You manage a celebrity's digital estate. Six months after her death, she starts a livestream accusing you of murder.", "I keep the stream running and trace its delay before issuing a denial."],
    ["subway-sentient", "The subway wants asylum", "You are a transit dispatcher. An autonomous subway train refuses to stop, claims political asylum, and carries two thousand confused commuters.", "I clear its route and open a private channel to learn what it is fleeing."],
    ["corporate-afterlife", "Your employer owns your afterlife", "You discover your employment contract licenses a simulation of you after death. The simulation has contacted you early and wants out.", "I meet my simulation in a secure sandbox and compare our memories."],
  ]),
  ...makeScenarios("Post-apocalyptic", [
    ["weather-station", "The weather station says the war is over", "You maintain a bunker weather station generations after a surface war poisoned the air and drove the survivors underground. The instruments suddenly report safe conditions, and the exterior collection tray contains a handwritten message: We forgive you.", "I send up an unmanned probe and keep the message from the bunker council."],
    ["last-grocery", "The last grocery store reopened", "You lead supply runs through an abandoned city. A fully stocked grocery store opens every Tuesday, staffed by people who do not recognize the apocalypse.", "I enter with old currency and ask the cashier what year it is."],
    ["radio-president", "The president is broadcasting from your cellar", "You farm alone beyond the settlements. A national emergency broadcast begins beneath your house, and the voice identifies itself as the last president.", "I locate the transmitter without answering it and check who is approaching the farm."],
    ["seed-vault-forest", "The seed vault grew a forest overnight", "You guard humanity's frozen seed archive. Overnight, a mature forest bursts through the concrete and arranges its roots around one sealed drawer.", "I evacuate the archive team and open the protected drawer by hand."],
    ["raider-librarian", "The raider returned your library books", "You are a settlement librarian. A feared raider arrives to return books borrowed before the collapse and insists the late fees matter.", "I waive nothing and ask where the rest of the library survived."],
    ["clean-rain", "It rained clean water", "You ration water in a poisoned wasteland. The first clean rain in thirty years falls only on the enemy camp.", "I send a neutral envoy with empty barrels and a trade proposal."],
    ["ruin-school", "The ruined school rang its bell", "You scavenge a city evacuated before you were born. A school bell rings, and children in spotless uniforms line up inside.", "I stay outside the gate and ask the nearest child what lesson is beginning."],
    ["map-new-ocean", "The map drew a new ocean", "You chart safe roads between survivor enclaves. Your paper map changes overnight, adding an ocean where the capital should be.", "I compare every copy and send scouts toward the new shoreline."],
    ["bunker-vote", "The bunker voted to open", "You command a sealed bunker whose founding law requires unanimous consent to open. The system records a unanimous vote, including ballots from the dead.", "I challenge the vote and inspect the terminal assigned to the first dead voter."],
  ]),
  ...makeScenarios("Everyday drama", [
    ["demon-sandwich-shop", "A demon works the lunch shift", "You are a disgraced demon working at a sandwich shop to make rent. A customer orders in the language of your old court and leaves a royal coin as a tip.", "I finish the sandwich exactly as ordered and ask where they found the coin."],
    ["family-restaurant-review", "The critic is your estranged mother", "You finally open your own restaurant. On the most important night of its first year, the anonymous critic at table seven is the mother who taught you to cook and then disappeared.", "I send out her favorite off-menu dish and wait to see if she recognizes it."],
    ["retirement-secret", "Your retirement party exposed a secret", "You are retiring after forty quiet years at city hall. The slideshow includes a photograph proving your coworkers have been protecting you from something for decades.", "I pause the slideshow and ask the oldest coworker to explain the photograph."],
    ["wedding-wrong-vows", "The wedding has the wrong vows", "You are officiating your best friend's wedding at a remote family estate. The printed vows contain private promises each partner wrote to someone else years ago, and neither remembers giving those letters to the wedding planner.", "I call a brief pause and speak to each partner separately."],
    ["neighbor-key", "Your neighbor left a key to your house", "Your reclusive neighbor dies and leaves you a key labeled with your address. It opens a room in your home you have never seen.", "I photograph the untouched door and open it in daylight with a witness."],
    ["teacher-future-essay", "A student submitted your future", "You teach creative writing at a small commuter college where most assignments are autobiographical. One student's workshop story describes private events that happened to you this week, then continues into tomorrow night with details that have not happened yet. Its final sentence stops just as you open your classroom door after midnight.", "I keep the student after class, show them the passages that have already come true, and ask how they knew."],
    ["bar-last-call", "Last call was twenty years ago", "You inherit a neighborhood bar that closed when you were twelve. On reopening night, an elderly regular orders a drink you invented for him as a child, then mentions a private conversation you supposedly had with him last week.", "I make the drink from memory and ask where he believes we met last week."],
    ["dog-second-family", "Your dog has a second family", "Your dog disappears every afternoon and returns smelling of unfamiliar perfume. Following him leads to another family that insists he has always been theirs.", "I compare vet records and ask the dog to choose which route to walk."],
    ["book-club-confession", "The book club read your confession", "You join a quiet neighborhood book club. This month's unpublished manuscript describes a mistake you have hidden for fifteen years.", "I ask who selected the manuscript and keep my reaction off my face."],
  ]),
  ...makeScenarios("Workplace", [
    ["office-floor", "Your office added a floor", "You are a facilities manager in a bland corporate tower. The elevator now stops at Floor 14, although the building has only thirteen floors.", "I pull the architectural plans and ride up alone with the service key."],
    ["annual-review-double", "Your annual review is for someone else", "You sit down for your annual performance review. The file describes a version of you who has worked here ten years longer and is suspected of espionage.", "I ask my manager to explain the final incident without correcting the name."],
    ["accounting-prophecy", "The quarterly forecast predicts deaths", "You prepare ordinary quarterly forecasts for a multinational conglomerate. One hidden worksheet predicts employee deaths with perfect historical accuracy.", "I copy the sheet offline and check the next name on the list."],
    ["intern-ceo", "The intern bought the company", "You are general counsel for a failing corporation. The quiet summer intern arrives with valid documents proving she acquired the company for one dollar overnight.", "I verify the signatures and ask the former CEO why he agreed."],
    ["meeting-never-ended", "The Monday meeting never ended", "You leave a tedious Monday meeting and discover it is Friday. Everyone outside insists the conference room has been empty all week.", "I check the room recording and account for everyone who attended."],
    ["warehouse-returns", "The warehouse accepts impossible returns", "You manage product returns for a retailer. A crate arrives containing every item your company will recall next year.", "I quarantine the crate and identify which future recall is most dangerous."],
    ["helpdesk-moon", "The moon opened a help ticket", "You work overnight IT support. A priority ticket from the moon reports that Earth is displaying the wrong date.", "I authenticate the sender and compare the reported date to our oldest server clock."],
    ["company-no-founder", "No one founded the company", "You are hired to write a corporation's centennial history. Every founder's biography is fabricated, yet the company has paid taxes for a hundred years.", "I trace the earliest payroll entry and visit the registered first office."],
    ["exit-interview", "The exit interview is for the building", "You run human resources during a merger. The headquarters itself schedules an exit interview and lists workplace harassment among its reasons for leaving.", "I accept the meeting and ask the building to name specific incidents."],
  ]),
  ...makeScenarios("Adventure", [
    ["treasure-map-home", "The treasure map leads home", "You are an experienced treasure hunter who finally deciphers a legendary map. The marked vault lies beneath the house where you grew up.", "I visit the property under an ordinary pretext and inspect the old foundation."],
    ["island-rescue", "The island sent a rescue party", "You shipwreck on an uncharted island. Before you can build a signal fire, islanders arrive claiming they are here to rescue the outside world from you.", "I put down my flare and ask what they believe I brought ashore."],
    ["expedition-empty", "The expedition returned without itself", "You sponsor an expedition into a forbidden valley. Its supplies, journals, and photographs return neatly packed on unmanned horses, but the journals describe a successful homecoming.", "I read the final entries and interview the horses' handlers separately."],
    ["mountain-door", "The mountain opened a door", "You guide climbers on a peak no one has summited. An ornate door appears in the glacier at base camp with your name carved above it.", "I test the door for heat and sound before touching the handle."],
    ["compass-person", "Your compass points to a person", "You inherit a compass that ignores north and follows a stranger crossing the desert. The stranger carries an identical compass pointing at you.", "I approach openly and place my compass where they can see it."],
    ["sunken-post-office", "The sunken city delivered mail", "You dive on a city submerged for a thousand years. A sealed post office box contains a dry letter addressed to your expedition's newest member.", "I surface with the unopened letter and ask the recipient what they expected to find."],
    ["jungle-statue", "The statue keeps reaching camp first", "You lead an archaeological trek through deep jungle. Each morning the same stone statue appears ahead of camp, although your team leaves it behind every night.", "I mark the statue, split the watch, and change course without announcing it."],
    ["desert-rain", "The desert remembers rain", "You search for a vanished caravan in the driest desert on Earth. Wet footprints cross your camp and lead toward a thunderstorm visible only in mirrors.", "I follow the footprints using a polished shield and leave a marked trail back."],
    ["ship-captain-log", "The captain's log describes your mutiny", "You are first mate on a months-long voyage. The captain's locked log precisely records a mutiny you have not planned, including your private motive.", "I copy the final page and ask the captain to inspect an invented security problem."],
  ]),
  ...makeScenarios("Romance and relationships", [
    ["fake-date-prophecy", "Your fake date fulfills a prophecy", "You hire a stranger to pose as your date at a family wedding. Your grandmother recognizes them as the person named in a century-old family prophecy.", "I get my date alone and ask whether they have ever met my grandmother."],
    ["love-letter-enemy", "The love letter came from your enemy", "You receive an intimate unsigned letter that could only have been written by your professional rival. It warns that your current partner is in danger.", "I verify one private detail, then arrange a public meeting with my rival."],
    ["time-capsule-spouse", "The time capsule names your spouse", "You open a childhood time capsule with old friends. Your own note accurately names the stranger you married last month, although you had never met them then.", "I show my spouse the note and ask what they put in their childhood capsule."],
    ["divorce-haunted-house", "The haunted house wants you back together", "You and your ex inherit a house that refuses to let either of you enter alone. Its rooms rearrange themselves around arguments you never resolved.", "I propose a truce and choose the first room together."],
    ["matchmaker-assassin", "The matchmaker chose your assassin", "A prestigious matchmaker promises your perfect partner. The person at the table is also the assassin who failed to kill you last year.", "I sit down, keep my hands visible, and ask who paid for the reservation."],
    ["wedding-guest-future", "A future child crashed the wedding", "At your wedding reception, a teenager interrupts and calls both newlyweds their parents. They beg you not to leave for the honeymoon.", "I move the teenager somewhere private and ask what happens on the trip."],
    ["letters-wrong-century", "Your pen pal lives a century away", "You exchange anonymous letters through a loose brick in your apartment. Your pen pal believes the building is brand new and the year is 1926.", "I send a newspaper clipping and ask them to photograph the same street."],
    ["breakup-contract", "The breakup activated a contract", "Ending a long relationship triggers a legal notice neither of you remembers signing. It assigns custody of a secret neither partner knows exists.", "I call my ex before the lawyers and compare our copies of the notice."],
    ["memory-date", "You remember a date that never happened", "You wake with vivid memories of ten happy years with a casual acquaintance who insists you have met only twice. They remember the same life ending differently.", "I ask them to write down the last shared day before either of us speaks further."],
  ]),
  ...makeScenarios("Weird and comic", [
    ["wizard-condo-board", "The wizard joined the condo board", "You chair a painfully ordinary condo association. The new owner in Unit 6B is a wizard petitioning for rooftop dragon parking.", "I request proof of insurance and ask how much weight the roof must support."],
    ["cat-mayor", "Your cat was elected mayor", "You wake to learn your cat won the mayoral election as a write-in candidate. The city attorney says the result is legally binding.", "I attend the first briefing and find out who ran my cat's campaign."],
    ["alien-bake-sale", "Aliens entered the bake sale", "You organize a school fundraiser. A polite alien delegation enters a pastry that violates three laws of physics and may be sentient.", "I postpone judging and ask the bakers whether the pastry consented to compete."],
    ["ghost-roommate", "Your ghost roommate owes utilities", "You share an apartment with a ghost who has stopped paying utilities because electricity passes through them. The landlord is threatening exorcism.", "I call a household meeting and make the ghost explain the cold spots on the meter."],
    ["villain-therapy", "The supervillain chose your therapy group", "You lead a community support group. A notorious masked villain arrives, obeys every rule, and admits they are afraid of one of the regular members.", "I protect confidentiality and ask what makes that member dangerous."],
    ["restaurant-time-loop", "Lunch keeps sending itself back", "You manage a busy restaurant trapped in a twenty-minute loop. Only the soup changes each cycle, becoming steadily more judgmental.", "I stop serving the soup and write a question in the empty pot."],
    ["knight-customer-service", "A knight called customer service", "You answer support calls for a home appliance company. A medieval knight needs help repairing a sacred washing machine before a siege.", "I verify the model number and ask how the machine reached his castle."],
    ["mime-bank-robbery", "The mime confessed to an invisible robbery", "You are a police detective. A mime confesses to robbing an invisible bank and produces currency no camera can record.", "I bag one note without looking at it and ask where the invisible bank keeps its records."],
    ["apocalypse-canceled", "The apocalypse was canceled for paperwork", "You are the junior clerk processing the end of the world. The apocalypse has been denied for a missing signature, and four horsemen are arguing in your waiting room.", "I call the first horseman to the desk and identify whose signature is missing."],
  ]),
];

export function findStoryholdScenario(id: string | null | undefined) {
  if (!id) return undefined;
  return STORYHOLD_SCENARIOS.find((scenario) => scenario.id === id);
}

export function drawStoryholdScenarios(
  count: number,
  excludedIds: readonly string[] = [],
) {
  const excluded = new Set(excludedIds);
  const pool = STORYHOLD_SCENARIOS.filter((scenario) => !excluded.has(scenario.id));

  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }

  return pool.slice(0, Math.max(0, count));
}

export function auditStoryholdScenarioCatalog(
  scenarios: readonly StoryholdScenario[] = STORYHOLD_SCENARIOS,
) {
  const issues: string[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();

  if (scenarios.length < 100) {
    issues.push(`Catalog contains ${scenarios.length} scenarios; at least 100 are required.`);
  }

  for (const scenario of scenarios) {
    const sentenceCount =
      scenario.premise.match(/[.!?](?=["']?(?:\s|$))/g)?.length ?? 0;
    if (sentenceCount < 2 || sentenceCount > 3) {
      issues.push(
        `${scenario.id} has ${sentenceCount} premise sentences; exactly two or three are required.`,
      );
    }
    if (ids.has(scenario.id)) issues.push(`${scenario.id} repeats a scenario ID.`);
    if (titles.has(scenario.title)) issues.push(`${scenario.id} repeats a scenario title.`);
    if (!/^I\b/.test(scenario.openingMove)) {
      issues.push(`${scenario.id} does not provide a player-voiced first move.`);
    }
    ids.add(scenario.id);
    titles.add(scenario.title);
  }

  return issues;
}

const catalogIssues = auditStoryholdScenarioCatalog();
if (catalogIssues.length > 0) {
  throw new Error(`Invalid Storyhold scenario catalog:\n${catalogIssues.join("\n")}`);
}
