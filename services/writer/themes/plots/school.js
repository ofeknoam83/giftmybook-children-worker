/**
 * School plot templates — 12 structurally distinct story arcs.
 *
 * Each template returns 13 spreads in 4-scene (A/B/C/D) grouping.
 * opts: { child, isYoung, wt, parentName, book, theme }
 */

module.exports = [
  {
    id: 'classic_school',
    name: 'Classic School Day',
    synopsis: 'The school bell rings and routine begins — but something unexpected disrupts the ordinary, sparks curiosity, and by day\'s end the child sees school (and themselves) differently.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'MORNING_WALK',     description: `${n} walks to school, backpack bouncing. The building looks the same as always — but today something will be different. ${n} doesn't know it yet. School path.`, wordTarget: wt },
        { spread: 2,  beat: 'BELL_RINGS',        description: `The bell rings. ${n} slides into a seat. The classroom hums with voices and scraped chairs. An ordinary beginning. Classroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DISRUPTION',        description: `Something unusual happens — a strange sound from the hall, a creature at the window, a note on the desk that wasn't there before. ${n} notices. Classroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'INVESTIGATING',     description: `${n} follows the clue — into the hallway, to the library, around a corner. School is full of hidden places. ${n} discovers one. School hallway.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'DISCOVERY',         description: `Something wonderful is found — a hidden room, a forgotten garden, a secret collection. School has a surprise inside it. Secret spot.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'UNDERSTANDING',     description: `${n} figures out why it's there, what it means. A connection forms — between the discovery and something ${n} cares about. Secret spot.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SHARING',           description: `${n} shows someone — a classmate, a creature, the classroom itself. The discovery grows when shared. Back in school.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CHALLENGE',         description: `Something needs doing — the garden needs watering, the creature needs helping, the mystery needs solving. ${n} steps up. School.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'SOLVING',           description: `Using something learned in class — a word, a number, a fact — ${n} solves the problem. School taught this without ${n} realizing. School.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'PRIDE',             description: `The warm rush of doing something that matters. ${n} stands taller. The classroom feels like a place where good things happen. Classroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'FINAL_BELL',        description: `The final bell rings. ${n} walks out of school slowly, looking back once at the building. It looks different now. School exit.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',      description: `${n} walks home with a secret — a piece of school nobody else noticed. Tomorrow the bell will ring again. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. School is ordinary until you look in the right corners. Echo the morning walk. Warm, brave, belonging.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'show_and_tell',
    name: 'Show and Tell',
    synopsis: 'The child brings something ordinary to show-and-tell — a rock, a spoon, a leaf — but while telling its story, the object transforms into something extraordinary in the class\'s imagination.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'CHOOSING',         description: `Show-and-tell day. ${n} searches for something to bring — fancy things, shiny things. Nothing feels right. Then: a plain, ordinary object catches ${n}'s eye. At home.`, wordTarget: wt },
        { spread: 2,  beat: 'DOUBT',            description: `On the walk to school, ${n} holds the ordinary thing and worries. Everyone else will have something better. What if they laugh? Walking to school.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OTHERS_SHARE',     description: `Classmates show sparkly, loud, impressive things. ${n} sinks lower in the chair. The ordinary thing feels smaller and plainer. Classroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'YOUR_TURN',        description: `${n}'s name is called. Legs feel heavy walking to the front. Every eye in the room. ${n} holds up the plain thing. Silence. Front of classroom.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FIRST_WORDS',      description: `${n} starts talking — where it was found, why it matters. The words come slowly at first, then faster. The story behind the object unfolds. Front of classroom.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'STORY_GROWS',      description: `As ${n} talks, the object seems to glow. The story makes it bigger — it's not just a rock, it's a piece of a mountain. Not just a leaf, it's a tree's letter. Front of classroom.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CLASS_LEANS_IN',   description: `Every classmate is leaning forward now. Eyes wide. The ordinary thing has become the most interesting thing in the room. The power of a good story. Classroom.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'MAGIC_MOMENT',     description: `${n} says something that makes the whole class gasp — a detail, a connection, a wonder hidden in the plain object. The emotional peak. Front of classroom.`, wordTarget: wt },
        { spread: 9,  beat: 'APPLAUSE',         description: `The class claps. Not polite clapping — real, excited clapping. ${n} feels the warmth rise from feet to face. The biggest feeling. Classroom.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'QUESTIONS',        description: `Everyone wants to ask questions, touch it, see it closer. ${n} passes it around carefully. The ordinary thing is now the class treasure. Classroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BACK_AT_DESK',     description: `${n} sits back down, the object safe in hand again. It looks different now — not because it changed, but because ${n} changed how everyone saw it. Classroom.`, wordTarget: wt },
        { spread: 12, beat: 'AFTER_SCHOOL',     description: `Walking home, ${n} looks at ordinary things everywhere — a crack in the sidewalk, a cloud, a doorknob. Every one has a story. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Nothing is ordinary if you know its story. Echo the first search. Warm, brave, extraordinary.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'new_kid',
    name: 'The New Kid',
    synopsis: 'A new kid arrives at school — quiet, unsure, alone at the edge. The child remembers what that feels like and decides to be the one who reaches out.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SOMEONE_NEW',      description: `A new face in the classroom doorway — standing still while everyone else moves. The new kid holds a backpack strap like a lifeline. ${n} notices. Classroom doorway.`, wordTarget: wt },
        { spread: 2,  beat: 'WATCHING',          description: `The new kid sits at the empty desk. Doesn't talk, just watches. Lunch box different, shoes different. ${n} remembers what "different" feels like. Classroom.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'RECESS_ALONE',     description: `Recess. The new kid stands by the wall, watching everyone play. ${n} sees them there and something tugs — a pull toward the lonely figure. Playground edge.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'FIRST_STEP',       description: `${n} walks over. The hardest six steps ever taken on a playground. "Hi. Want to play?" Two simple words, one enormous act of courage. Playground.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'AWKWARD_START',     description: `They try to play but it's awkward — silences, shy glances, not knowing the same games. ${n} doesn't give up. They try something else. Playground.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'COMMON_GROUND',    description: `Something clicks — they both like the same thing. A game, a joke, a silly noise. The first real laugh between them. Small but electric. Playground.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'TOGETHER',         description: `Now they're playing for real — running, building, inventing. The wall where the new kid stood is empty. Nobody is watching from the edges anymore. Playground.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'LUNCH_TABLE',      description: `Back inside, ${n} waves the new kid over to sit together at lunch. Sharing food, sharing stories. The table feels bigger with two. Cafeteria.`, wordTarget: wt },
        { spread: 9,  beat: 'NEW_KID_SHINES',   description: `The new kid does something wonderful — tells a funny story, draws something amazing, knows something nobody else knows. ${n} sees them glow. Classroom.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'BELONGING',        description: `The class starts to notice. Others join in. The new kid isn't new anymore — they're just a kid. ${n} made that happen, quietly. Classroom.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'END_OF_DAY',       description: `The bell rings. The new kid waves goodbye to ${n} from the door — a real wave, not a shy one. Tomorrow they'll sit together again. School exit.`, wordTarget: wt },
        { spread: 12, beat: 'WALKING_HOME',     description: `${n} walks home feeling taller. Being the first to say hello is the bravest thing ${n} has ever done. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Every friend was once a stranger standing in a doorway. Echo the first notice. Warm, brave, belonging.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'art_class',
    name: 'Art Class Masterpiece',
    synopsis: 'In art class, everything goes "wrong" — paint splatters, colors mix, the paper crinkles. But the accident becomes a masterpiece, and the child learns that mistakes can be beautiful.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'ART_BEGINS',       description: `Art class. Brushes, paints, white paper. ${n} has a plan — something perfect, something precise. The brush dips in and touches down. Art room.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_MISTAKE',    description: `A drip. Blue paint lands where it shouldn't. ${n} frowns. It was supposed to be perfect. The spot stares up, messy and blue. Art table.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'MORE_MESS',        description: `Trying to fix the drip makes it worse. Red mixes into the blue, making an unexpected purple. The paper crinkles. ${n}'s cheeks burn. Art table.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GIVING_UP',        description: `${n} wants to start over. Crumple it up. But something about the purple catches the light — it's actually beautiful. A pause. ${n} looks closer. Art table.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'LEANING_IN',       description: `Instead of fighting the mess, ${n} adds to it. Another splatter, on purpose this time. Green into yellow — a starburst. The paper blooms. Art table.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'PLAYING_NOW',      description: `${n} is playing now — fingerprints become flowers, the crinkle becomes a mountain range, the drip becomes a river. The mistake is the map. Art table.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'LOST_IN_IT',       description: `Time disappears. ${n} doesn't hear the room, doesn't see anyone. Just color and shape and the feeling of making something real. Art table.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'STEPPING_BACK',    description: `${n} leans back and looks at the whole painting. It's wild, layered, surprising. It doesn't look like the plan — it looks better. The quietest pride. Art table.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 9,  beat: 'TEACHER_SEES',     description: `The art teacher stops behind ${n} and says nothing for a long moment. Then: "That's extraordinary." The biggest compliment in the smallest words. Art room.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'CLASSMATES_LOOK',  description: `Other kids gather around. "How did you do that?" ${n} grins: "I messed up." They laugh — not at ${n}, with ${n}. The painting glows. Art room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'DRYING',           description: `The painting hangs on the drying line, colors still wet and shining. ${n} walks past it three times just to look. Art room wall.`, wordTarget: wt },
        { spread: 12, beat: 'CARRYING_HOME',    description: `${n} carries the dry painting home, holding it carefully by the edges. The masterpiece that started as a mess. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best art happens when the plan falls apart and you keep going. Echo the first drip. Warm, messy, magnificent.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'field_trip',
    name: 'The Field Trip',
    synopsis: 'The school bus pulls up somewhere extraordinary — a museum where the paintings whisper, a farm where the animals know secrets, a forest where every tree has a lesson.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BUS_RIDE',         description: `${n} bounces on the school bus seat, nose pressed to the window. The bus leaves the familiar streets behind. A field trip! Something new. School bus.`, wordTarget: wt },
        { spread: 2,  beat: 'ARRIVAL',           description: `The bus stops. Everyone piles out. Before them: a place that seems to shimmer with hidden stories — a museum, a farm, a forest edge. ${n} stares. Arrival.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_WONDER',      description: `The first astonishing thing — a skeleton taller than the ceiling, a flower with a face, a tree older than the school. ${n}'s mouth drops open. The field trip site.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'GOING_DEEPER',      description: `Moving deeper into the place. Each room or path reveals something stranger and more wonderful. ${n} falls behind the group, lingering. The site.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'PERSONAL_FIND',     description: `${n} discovers something that connects to a personal interest — something nobody else notices. A quiet thrill of recognition. A private treasure. The site.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'LEARNING',          description: `A fact or story changes how ${n} sees something. The world is older, bigger, stranger than imagined. Knowledge lands like a spark. The site.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'WONDER_PEAK',       description: `The most extraordinary thing — the painting that seems alive, the animal that holds ${n}'s gaze, the view from the hilltop. Breathtaking. The site.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'SHARING_EXCITEMENT',description: `${n} grabs a classmate's arm: "Look at this!" Sharing wonder doubles it. Two faces lit up by the same incredible thing. The site.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'LUNCH_SPOT',        description: `Lunch on the grass outside. Sandwiches taste better when you're somewhere new. ${n} talks with a full mouth about everything seen. Outside the site.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'LAST_LOOK',         description: `Time to go. ${n} runs back for one last look at the best thing. Memorizing it — the color, the shape, the feeling. Trying to keep it forever. The site.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BUS_HOME',          description: `On the bus home, ${n} presses nose to the window again. The world outside looks different now. Everything has a story underneath. School bus.`, wordTarget: wt },
        { spread: 12, beat: 'TELLING_ABOUT_IT',  description: `At home, ${n} talks nonstop about the trip — waving hands, eyes huge. Some things can only be understood by seeing them. NOT bedtime. At home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The best classrooms don't have walls. Echo the bus window. Warm, wide-eyed, changed.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'library_book',
    name: 'The Library Book',
    synopsis: 'A book in the school library glows faintly on its shelf. The child opens it and the words pull them in — the story becomes real around them, and the lesson is the adventure.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'LIBRARY_VISIT',    description: `Library hour. ${n} wanders the shelves, fingers trailing along spines. One book is warm to the touch. It pulses faintly, like a heartbeat. School library.`, wordTarget: wt },
        { spread: 2,  beat: 'OPENING',           description: `${n} opens the book. The first page shimmers. The letters rearrange themselves to spell ${n}'s name. The room starts to blur at the edges. Library.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FALLING_IN',        description: `The library dissolves. ${n} tumbles gently into the story — landing in a world made of ink and paper, where the sky is written and the ground is parchment. Book world.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'STORY_WORLD',       description: `The book's setting comes alive — a paper forest with ink animals, a castle built from stacked paragraphs, rivers of flowing sentences. Beautiful and strange. Book world.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'BOOK_CHARACTER',    description: `A character from the story greets ${n} — made of letters and illustrations, friendly and curious. They need help finishing their own story. Book world.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'THE_QUEST',         description: `The story needs a missing word — a word that will complete the ending. Without it, the book can never be finished. ${n} agrees to help find it. Book world.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'SEARCHING',         description: `Through chapters and pages — climbing punctuation marks, crossing footnotes, sliding down margins. Every part of the book is a landscape to explore. Book world.`, wordTarget: wt + 2 },
        { spread: 8,  beat: 'FINDING_THE_WORD',  description: `${n} finds the missing word — not in the book at all, but in ${n}'s own heart. A word ${n} knows and believes. Speaking it into the story. Book world.`, wordTarget: wt },
        { spread: 9,  beat: 'STORY_COMPLETES',   description: `The word fills the page. The story rewrites itself around ${n} — the ending unfolds, beautiful and whole. The character smiles. Book world.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'RETURNING',         description: `The pages flip in reverse. Letters fly past. ${n} feels the library chair beneath again, the book warm and quiet in hand. Library.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BOOK_ON_SHELF',     description: `${n} places the book back on the shelf. It's still warm. The spine now shows a new title — something personal, something changed. School library.`, wordTarget: wt },
        { spread: 12, beat: 'AFTER_LIBRARY',     description: `Back in class, ${n} can't stop thinking about the book. Every book on every shelf might hold a whole world inside. NOT bedtime. Classroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. Every book is a door — and you're always the missing word. Echo the warm spine. Warm, written, alive.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'science_experiment',
    name: 'The Science Experiment',
    synopsis: 'A school science experiment goes wonderfully "wrong" — the volcano erupts in rainbow, the plant grows to the ceiling, the baking soda creates a creature. Chaos becomes wonder.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SETTING_UP',       description: `Science class. Beakers, measuring cups, safety goggles. ${n} reads the instructions carefully. Everything measured, everything precise. Science table.`, wordTarget: wt },
        { spread: 2,  beat: 'MIXING',           description: `The first ingredients combine. Bubbles form — normal. Colors swirl — expected. ${n} follows the steps perfectly. Almost done. Science table.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'OOPS',             description: `An extra drop of something. The wrong amount. ${n}'s hand slips. The mixture fizzes louder than it should. The beaker shakes. Science table.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'ERUPTION',         description: `WHOOSH! The experiment erupts — not in disaster, but in rainbow-colored foam that spirals upward in beautiful shapes. The class gasps. Science table.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GROWING',          description: `The foam keeps going — swirling into shapes, forming tiny structures, building itself into something nobody planned. It's alive with color. Science room.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'WONDER_CHAOS',     description: `The room fills with the experiment — foam flowers on desks, fizzy rivers between chairs, a bubbly castle on the windowsill. Beautiful chaos. Science room.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'CREATURE',         description: `From the center of the foam: a small, fizzy creature blinks open its bubble eyes. It looks at ${n}. ${n} looks back. A moment of pure, silent wonder. Science table.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'PLAYING',          description: `The creature bounces around the room. It's friendly, curious, fizzy. It lands on ${n}'s shoulder and purrs in bubbles. The class crowds around. Science room.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'UNDERSTANDING',    description: `${n} looks at the ingredients and realizes: the "mistake" created something the instructions never could. The best discoveries are accidents. Science table.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'FADING',           description: `The foam slowly dissolves. The creature pops gently into sparkles. The room returns to normal — but shinier. Science room.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'WRITING_IT_DOWN',  description: `${n} writes down everything in a notebook: what was mixed, what happened, what was learned. A real scientist records everything, especially the mistakes. Science table.`, wordTarget: wt },
        { spread: 12, beat: 'AFTER_CLASS',      description: `Walking to the next class, ${n} still has a fleck of rainbow foam on one sleeve. A badge of brilliant failure. NOT bedtime. School hallway.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best experiments are the ones that surprise the scientist. Echo the extra drop. Warm, fizzy, magnificent.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'recess_kingdom',
    name: 'The Recess Kingdom',
    synopsis: 'At recess, the playground transforms — the slide is a mountain, the sandbox a desert, the monkey bars a bridge between kingdoms. The child rules it all for twenty glorious minutes.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'BELL_RINGS',       description: `The recess bell sings. ${n} bursts through the door into sunlight. The playground stretches out — but today it doesn't look like a playground. It looks like a kingdom. Playground.`, wordTarget: wt },
        { spread: 2,  beat: 'SLIDE_MOUNTAIN',   description: `The slide is a silver mountain. ${n} climbs it, plants a flag (a stick with a leaf), and surveys the realm below. Ruler of the mountain. Slide.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'SANDBOX_DESERT',   description: `The sandbox is a vast desert. ${n} crosses it in great strides, discovering buried treasures — a bottle cap gem, a sparkly rock, a lost marble. Sandbox.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'MONKEY_BRIDGE',    description: `The monkey bars are a bridge between two kingdoms. ${n} swings across, hand over hand, over an imaginary river full of friendly crocodiles. Monkey bars.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'TIRE_THRONE',      description: `The old tire becomes a throne. ${n} sits in it and makes royal decrees: "More cookies at lunch! Longer recess! Extra art!" The kingdom cheers. Tire swing.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'KINGDOM_QUEST',    description: `A quest! Something is missing from the kingdom — a golden acorn, a magic pebble. ${n} searches the realm — under bushes, behind the shed. Playground.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FINDING_IT',       description: `Found! Hidden in the roots of the big tree by the fence. ${n} holds it up to the light. The kingdom is saved. The quietest triumph. Playground tree.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'CASTLE_BUILDING',  description: `Building a castle from sticks and leaves near the fence. Every kingdom needs a castle. ${n} works fast — recess is ticking. Near the fence.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BATTLE_AND_PEACE', description: `An imaginary dragon appears (a gust of wind). ${n} faces it bravely, then befriends it. Every good ruler makes peace. Playground.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'KINGDOM_PARTY',    description: `A victory feast — snack crackers shared on the throne, water from the fountain served in cupped hands. A royal banquet for a twenty-minute kingdom. Playground.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BELL_RETURNS',     description: `The end-of-recess bell. The kingdom shimmers and becomes a playground again. ${n} walks to the door, looking back once at the realm. Playground.`, wordTarget: wt },
        { spread: 12, beat: 'BACK_IN_CLASS',    description: `Sitting at the desk, ${n} can see the playground through the window. The slide is just a slide — but ${n} knows better. NOT bedtime. Classroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Every playground is a kingdom for anyone brave enough to crown themselves. Echo the first bell. Warm, wild, royal.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'lost_and_found',
    name: 'The Lost and Found',
    synopsis: 'The child discovers something in the school lost-and-found box that doesn\'t belong to anyone — a glowing compass, a tiny journal, a key. Finding its owner becomes the day\'s mission.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'FINDING',          description: `${n} digs through the lost-and-found box looking for a missing mitten. Instead: something strange at the bottom — warm, glowing faintly, not from this school. School hallway.`, wordTarget: wt },
        { spread: 2,  beat: 'EXAMINING',        description: `${n} studies the object — it has initials, or marks, or a clue scratched into its surface. Who lost this? When? It matters to someone. School hallway.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'FIRST_ASK',        description: `${n} asks around — "Is this yours?" Head shakes, blank looks. Nobody in the classroom recognizes it. The mystery deepens. Classroom.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'LIBRARY_CLUE',     description: `The librarian examines it and finds a clue — a number, a date, a faded word. It points somewhere else in the school. ${n} is on the trail. Library.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'FOLLOWING_CLUES',  description: `Through the school — the music room, the janitor's closet, the old stairwell. Each stop reveals another hint about the object's owner. School corridors.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'ALMOST_GIVING_UP', description: `The trail goes cold. ${n} sits on the stairs, turning the object over and over. Maybe it's been lost too long. Maybe nobody is looking for it anymore. Stairwell.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'NEW_LEAD',         description: `A teacher passing by says: "I've seen something like that before." A new direction, new energy. ${n} jumps up and follows the lead. School hallway.`, wordTarget: wt },
        { spread: 8,  beat: 'DISCOVERY',        description: `In a quiet corner of the school — a display case, a garden, a special wall — ${n} finds the match. The object belongs here, to the school's history. Special school spot.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'PLACING_IT_BACK',  description: `${n} places the object where it belongs. It clicks into place — literally or figuratively. Something is whole again. The most satisfying moment. Special spot.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'RECOGNITION',      description: `Someone sees what ${n} did — a teacher, the principal, a custodian. Not a big fuss, just a nod and a "Thank you. That's been missing a long time." Special spot.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'SCHOOL_DIFFERENT',  description: `Walking through the school afterward, ${n} sees it differently. The building has stories in its walls. Every scratch and stain is a memory. School hallway.`, wordTarget: wt },
        { spread: 12, beat: 'END_OF_DAY',       description: `${n} walks home past the lost-and-found box. It's just a box now. But it wasn't just a box today. NOT bedtime. School exit.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. Lost things wait patiently for the right person to find them. Echo the first dig. Warm, curious, restored.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'school_garden',
    name: 'The School Garden',
    synopsis: 'The class plants a garden. The child tends one special seed — watering it, talking to it, protecting it — and when it finally sprouts, the wonder of growing something is overwhelming.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'PLANTING_DAY',     description: `Dirt under fingernails, a tiny seed in ${n}'s palm. So small, so plain. Hard to believe anything could come from this. ${n} drops it in the hole. School garden.`, wordTarget: wt },
        { spread: 2,  beat: 'FIRST_WATER',      description: `${n} waters the spot carefully — not too much, not too little. The soil darkens. Somewhere under there, the seed is drinking. School garden.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'WAITING',           description: `Days pass. Nothing. Bare soil stares back. ${n} checks every morning before class — kneeling, peering, hoping. Other kids' plants haven't sprouted either. School garden.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TALKING_TO_IT',     description: `${n} starts talking to the seed. "Come on, you can do it." Whispering encouragement to dirt. It feels silly. It also feels right. School garden.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'GREEN_THREAD',      description: `One morning — a green thread! Pushing through the soil, curling upward. Tiny, determined, alive. ${n} shouts and the whole class comes running. School garden.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'GROWING',           description: `The sprout grows bigger each day. First a stem, then a leaf, then two leaves. ${n} measures it with a finger — yesterday it was one knuckle, today it's two. School garden.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FIRST_BUD',        description: `A bud appears — tight, green, holding something secret inside. ${n} leans close, cheek against the soil, and imagines the flower waiting in there. School garden.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'RAIN_WORRY',       description: `A hard rain comes. ${n} worries from the classroom window — is the plant okay? Running out after the rain: it's bent but standing. Relief floods in. School garden.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BLOOM',            description: `The bud opens. A flower — bright, impossibly beautiful, alive because ${n} cared for it. Color that ${n} grew from a plain seed. School garden.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'SHOWING_OTHERS',   description: `${n} brings the class to see. Everyone's plants are growing too now — a whole garden of small miracles. ${n}'s flower stands among them. School garden.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BEE_VISITS',       description: `A bee lands on ${n}'s flower. It buzzes, collects pollen, and flies away. The flower is part of the world now — not just ${n}'s anymore. School garden.`, wordTarget: wt },
        { spread: 12, beat: 'CARRYING_HOME',    description: `${n} walks home thinking about the garden. Something is growing at school that wasn't there before — and ${n} made it happen. NOT bedtime. Walking home.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The most patient thing a person can do is believe in a seed. Echo the first planting. Warm, green, grown.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'talent_show',
    name: 'The Talent Show',
    synopsis: 'The child signs up for the school talent show — nervous, excited, terrified. The practice, the stage fright, the moment under the lights, and the thunderous applause.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'SIGNING_UP',       description: `A poster on the wall: SCHOOL TALENT SHOW. ${n}'s hand shakes writing a name on the sign-up sheet. There. Done. No going back. School hallway.`, wordTarget: wt },
        { spread: 2,  beat: 'PRACTICING',        description: `At home, practicing the act — singing, dancing, telling jokes, doing magic, playing something. Over and over. Getting better. Getting nervous. At home.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'DOUBT',             description: `What if they laugh? What if ${n} forgets? What if it's terrible? The mirror reflection looks worried. ${n} almost crosses out the name on the list. At home.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'SHOW_DAY',          description: `The auditorium is set up — chairs, a stage, a curtain. It's real. ${n}'s stomach flips. Other kids are warming up backstage. ${n} peeks through the curtain. Backstage.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'WATCHING_OTHERS',   description: `From the wings, ${n} watches other acts — some great, some wobbly, all brave. Everyone is scared. Everyone does it anyway. ${n} understands now. Backstage.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'NAME_CALLED',       description: `"Next up: ${n}!" The walk to center stage is the longest walk in the world. Bright lights, dark audience, the smell of dust and anticipation. Stage.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'FROZEN_MOMENT',     description: `A beat of silence. ${n} stands in the spotlight, heart hammering. The whole world is this circle of light. Then — a deep breath. And the act begins. Stage.`, wordTarget: wt },
        { spread: 8,  beat: 'PERFORMING',        description: `${n} performs — and it's not perfect, but it's real. A wobble here, a brilliant moment there. The audience leans in. ${n} is doing it. Stage.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'BEST_MOMENT',       description: `The best part of the act — the high note, the final trick, the punchline. ${n} nails it. The feeling is like flying. Stage.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 10, beat: 'APPLAUSE',          description: `Thunder. The audience claps and cheers. ${n} stands in the sound of it, glowing from the inside out. This is what brave feels like. Stage.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'OFFSTAGE',          description: `Walking offstage on shaking legs. Other kids pat ${n}'s back. "That was amazing!" The shaking turns to laughing. Backstage.`, wordTarget: wt },
        { spread: 12, beat: 'AFTER_SHOW',        description: `Outside the school, ${n} still feels the stage lights' warmth on skin. The fear is gone. What's left is a quiet, glowing pride. NOT bedtime. School exit.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',           description: `The last line. The scariest step is the one onto the stage — and it's always worth taking. Echo the shaking hand. Warm, brave, applauded.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
  {
    id: 'lunch_table',
    name: 'The Lunch Table',
    synopsis: 'The magic of the lunch table — sharing food, swapping stories, making up games with napkins and straws. A single lunch period becomes a feast of friendship and belonging.',
    beats: (opts) => {
      const { child, wt } = opts;
      const n = child.name;
      return [
        { spread: 1,  beat: 'LUNCH_BELL',       description: `The lunch bell is the best bell. ${n} grabs a lunch box and heads to the cafeteria. The air smells like warm bread and possibility. School hallway.`, wordTarget: wt },
        { spread: 2,  beat: 'FINDING_A_SEAT',   description: `The cafeteria buzzes. ${n} scans the room — where to sit today? Every table is a different country. ${n} picks one and slides in. Cafeteria.`, wordTarget: wt + 2 },
        { spread: 3,  beat: 'UNPACKING',        description: `Opening the lunch box — each compartment a surprise. A sandwich, something crunchy, something sweet. ${n} arranges it like a tiny feast on the table. Lunch table.`, wordTarget: wt + 2 },
        { spread: 4,  beat: 'TRADING',          description: `The sacred art of lunch trading. "I'll give you my crackers for your grapes." Negotiations, deals, the economy of the cafeteria. Lunch table.`, wordTarget: wt + 2 },
        { spread: 5,  beat: 'STORIES',          description: `Someone tells a story that makes milk nearly come out of noses. ${n} adds to it — a detail that makes it funnier, wilder. The table becomes a stage. Lunch table.`, wordTarget: wt + 2 },
        { spread: 6,  beat: 'INVENTION',        description: `${n} builds something from lunch scraps — a straw catapult, a napkin origami bird, a grape sculpture. The table becomes a workshop. Lunch table.`, wordTarget: wt + 2 },
        { spread: 7,  beat: 'QUIET_BITE',       description: `A moment of quiet chewing. ${n} looks around the table at the faces — laughing, eating, being together. The simplest kind of happiness. Lunch table.`, wordTarget: opts.isYoung ? 12 : 15 },
        { spread: 8,  beat: 'GAME',             description: `Someone invents a game — guess the flavor, thumb war, a word game. The whole table plays. Competitive, silly, loud. Maximum energy. Lunch table.`, wordTarget: wt + 2 },
        { spread: 9,  beat: 'NEW_PERSON',       description: `Someone new sits down — not their usual table. ${n} scoots over to make room. The table grows. More food to share, more stories to tell. Lunch table.`, wordTarget: wt + 2 },
        { spread: 10, beat: 'DESSERT_MOMENT',   description: `The best part of lunch: dessert. ${n} saves it for last, takes a bite, and declares it the greatest thing ever created. Everyone agrees. Lunch table.`, wordTarget: wt + 2 },
        { spread: 11, beat: 'BELL_AGAIN',       description: `The bell. Lunch is over. Wrappers crumpled, boxes closed, chairs scraped back. Twenty minutes that felt like a whole world. Cafeteria.`, wordTarget: wt },
        { spread: 12, beat: 'AFTERNOON',        description: `In the afternoon class, ${n}'s stomach is full and heart is fuller. The lunch table is just a table now, but tomorrow it will be everything again. NOT bedtime. Classroom.`, wordTarget: wt },
        { spread: 13, beat: 'CLOSING',          description: `The last line. The best table in the world is the one where someone saved you a seat. Echo the lunch bell. Warm, full, together.`, wordTarget: opts.isYoung ? 12 : 15 },
      ];
    },
  },
];
